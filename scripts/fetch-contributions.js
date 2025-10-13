#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const { Octokit } = require('@octokit/rest');
const { throttling } = require('@octokit/plugin-throttling');

const MyOctokit = Octokit.plugin(throttling);

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const CACHE_CONTRIBUTIONS_DIR = path.join(CACHE_DIR, 'contributions');
const OUTPUT_DIR = path.join(__dirname, '..', 'data');
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const SINCE_DATE = '2022-07-01T00:00:00Z';
const CACHE_DURATION_HOURS = 23;
const DEFAULT_BATCH_SIZE = 10;
const RATE_LIMIT_THRESHOLD = 500; // Stop if remaining requests < this
const BATCH_DELAY_MS = 60000; // 1 minute delay between batches

class ContributionFetcher {
  constructor(token, force = false, batchNumber = null, batchAll = false, batchSize = DEFAULT_BATCH_SIZE) {
    this.force = force;
    this.batchNumber = batchNumber;
    this.batchAll = batchAll;
    this.batchSize = batchSize;
    this.apiCallCount = 0;
    this.octokit = new MyOctokit({
      auth: token,
      throttle: {
        onRateLimit: (retryAfter, options) => {
          console.warn(`Rate limit hit, retrying after ${retryAfter} seconds`);
          return true;
        },
        onSecondaryRateLimit: (retryAfter, options) => {
          console.warn(`Secondary rate limit hit, retrying after ${retryAfter} seconds`);
          return true;
        },
      },
    });
  }

  async loadConfig() {
    const contributorsFile = await fs.readFile(path.join(CONFIG_DIR, 'contributors.yaml'), 'utf8');
    const reposFile = await fs.readFile(path.join(CONFIG_DIR, 'repositories.yaml'), 'utf8');
    
    this.contributors = yaml.load(contributorsFile);
    this.repositories = yaml.load(reposFile);
  }

  async getCacheKey(repo, user, type) {
    return `${repo.owner}_${repo.name}_${user}_${type}`;
  }

  async loadCache() {
    const cacheFile = path.join(CACHE_DIR, 'last-fetch.json');
    try {
      const data = await fs.readFile(cacheFile, 'utf8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  async saveCache(cache) {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, 'last-fetch.json'), JSON.stringify(cache, null, 2));
  }

  async checkRateLimit() {
    try {
      const { data } = await this.octokit.rateLimit.get();
      const core = data.resources.core;
      return {
        remaining: core.remaining,
        limit: core.limit,
        reset: new Date(core.reset * 1000),
        used: core.limit - core.remaining,
      };
    } catch (error) {
      console.warn('Could not check rate limit:', error.message);
      return null;
    }
  }

  async waitIfNeededForRateLimit() {
    const rateLimit = await this.checkRateLimit();
    if (!rateLimit) return;

    console.log(`API Usage: ${rateLimit.used}/${rateLimit.limit} (${rateLimit.remaining} remaining)`);

    if (rateLimit.remaining < RATE_LIMIT_THRESHOLD) {
      const now = new Date();
      const waitTime = rateLimit.reset - now;
      if (waitTime > 0) {
        console.warn(`\nRate limit low (${rateLimit.remaining} remaining). Waiting until ${rateLimit.reset.toLocaleTimeString()}...`);
        await new Promise(resolve => setTimeout(resolve, waitTime + 1000));
      }
    }
  }

  shouldFetch(cacheKey, cache) {
    if (this.force) {
      return true;
    }

    const lastFetch = cache[cacheKey];
    if (!lastFetch) {
      return true; // Never fetched before
    }

    const lastFetchDate = new Date(lastFetch);
    const now = new Date();
    const hoursSinceLastFetch = (now - lastFetchDate) / (1000 * 60 * 60);

    return hoursSinceLastFetch >= CACHE_DURATION_HOURS;
  }

  async loadCachedContributions(username, repo) {
    const cacheFile = path.join(CACHE_CONTRIBUTIONS_DIR, `${username}_${repo.name}.json`);
    try {
      const data = await fs.readFile(cacheFile, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async saveCachedContributions(username, repo, contributions) {
    await fs.mkdir(CACHE_CONTRIBUTIONS_DIR, { recursive: true });
    const cacheFile = path.join(CACHE_CONTRIBUTIONS_DIR, `${username}_${repo.name}.json`);
    await fs.writeFile(cacheFile, JSON.stringify(contributions, null, 2));
  }

  mergeContributions(oldContribs, newContribs) {
    const merged = {
      commits: [],
      prs: [],
      issues: [],
      reviews: [],
    };

    // Merge commits (deduplicate by SHA)
    const commitMap = new Map();
    [...(oldContribs?.commits || []), ...(newContribs?.commits || [])].forEach(commit => {
      commitMap.set(commit.sha, commit);
    });
    merged.commits = Array.from(commitMap.values()).sort((a, b) =>
      new Date(b.date) - new Date(a.date)
    );

    // Merge PRs (deduplicate by number)
    const prMap = new Map();
    [...(oldContribs?.prs || []), ...(newContribs?.prs || [])].forEach(pr => {
      prMap.set(pr.number, pr);
    });
    merged.prs = Array.from(prMap.values()).sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    );

    // Merge reviews (deduplicate by pr_number)
    const reviewMap = new Map();
    [...(oldContribs?.reviews || []), ...(newContribs?.reviews || [])].forEach(review => {
      reviewMap.set(review.pr_number, review);
    });
    merged.reviews = Array.from(reviewMap.values()).sort((a, b) =>
      new Date(b.reviewed_at) - new Date(a.reviewed_at)
    );

    return merged;
  }

  async fetchPRDetails(repo, prNumber) {
    try {
      // Fetch reviews
      const reviews = await this.octokit.pulls.listReviews({
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        per_page: 100,
      });

      // Fetch PR details including merged_by
      const prData = await this.octokit.pulls.get({
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
      });

      // Fetch comments (issue comments)
      const comments = await this.octokit.issues.listComments({
        owner: repo.owner,
        repo: repo.name,
        issue_number: prNumber,
        per_page: 100,
      });

      const readyAt = prData.data.draft ? null : prData.data.created_at;
      const mergedAt = prData.data.merged_at;
      const mergedBy = prData.data.merged_by?.login || null;

      // Process reviews
      const reviewsData = reviews.data
        .filter(r => r.user && r.submitted_at) // Filter out null users
        .map(r => ({
          reviewer: r.user.login,
          submitted_at: r.submitted_at,
          state: r.state,
        }))
        .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));

      // Process comments
      const commentsData = comments.data
        .filter(c => c.user)
        .map(c => ({
          commenter: c.user.login,
          commented_at: c.created_at,
        }))
        .sort((a, b) => new Date(a.commented_at) - new Date(b.commented_at));

      // Calculate time to first review
      let timeToFirstReviewHours = null;
      if (readyAt && reviewsData.length > 0) {
        const firstReview = reviewsData[0];
        const readyDate = new Date(readyAt);
        const reviewDate = new Date(firstReview.submitted_at);
        timeToFirstReviewHours = (reviewDate - readyDate) / (1000 * 60 * 60);
      }

      // Calculate time to merge
      let timeToMergeHours = null;
      if (readyAt && mergedAt) {
        const readyDate = new Date(readyAt);
        const mergeDate = new Date(mergedAt);
        timeToMergeHours = (mergeDate - readyDate) / (1000 * 60 * 60);
      }

      return {
        merged_by: mergedBy,
        reviews: reviewsData,
        comments: commentsData,
        time_to_first_review_hours: timeToFirstReviewHours,
        time_to_merge_hours: timeToMergeHours,
      };
    } catch (error) {
      console.warn(`    Could not fetch details for PR #${prNumber}: ${error.message}`);
      return {
        merged_by: null,
        reviews: [],
        comments: [],
        time_to_first_review_hours: null,
        time_to_merge_hours: null,
      };
    }
  }

  async fetchUserContributions(username, repo, since) {
    const contributions = {
      commits: [],
      prs: [],
      issues: [],
      reviews: [],
    };

    try {
      // Fetch commits
      console.log(`  Fetching commits...`);
      const commits = await this.octokit.paginate(this.octokit.repos.listCommits, {
        owner: repo.owner,
        repo: repo.name,
        author: username,
        since: since,
        per_page: 100,
      });

      contributions.commits = commits.map(commit => ({
        sha: commit.sha,
        message: commit.commit.message.split('\n')[0],
        date: commit.commit.author.date,
        url: commit.html_url,
      }));
      console.log(`  Found ${contributions.commits.length} commits`);

      // Fetch PRs using GraphQL Search API
      console.log(`  Fetching PRs...`);
      const sinceDate = since.split('T')[0]; // Convert to YYYY-MM-DD
      const prsQuery = `
        query($searchQuery: String!) {
          search(query: $searchQuery, type: ISSUE, first: 100) {
            issueCount
            edges {
              node {
                ... on PullRequest {
                  number
                  title
                  state
                  createdAt
                  closedAt
                  mergedAt
                  url
                  isDraft
                }
              }
            }
          }
        }
      `;

      const searchQuery = `repo:${repo.owner}/${repo.name} is:pr author:${username} created:>=${sinceDate}`;
      const prsResponse = await this.octokit.graphql(prsQuery, { searchQuery });

      if (prsResponse.search && prsResponse.search.edges) {
        console.log(`  Found ${prsResponse.search.edges.length} PRs, fetching detailed review data...`);
        for (const edge of prsResponse.search.edges) {
          const pr = edge.node;

          // Fetch detailed review data for this PR
          const prDetails = await this.fetchPRDetails(repo, pr.number);

          contributions.prs.push({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            created_at: pr.createdAt,
            closed_at: pr.closedAt,
            merged_at: pr.mergedAt,
            merged_by: prDetails.merged_by,
            author: username, // Track the PR author
            url: pr.url,
            ready_for_review_at: pr.isDraft ? null : pr.createdAt,
            reviews: prDetails.reviews,
            comments: prDetails.comments,
            time_to_first_review_hours: prDetails.time_to_first_review_hours,
            time_to_merge_hours: prDetails.time_to_merge_hours,
          });
        }
        console.log(`  Processed ${contributions.prs.length} PRs with review data`);
      }

      // Fetch reviews using GraphQL Search API (Note: reviewed-by is deprecated but still works for now)
      console.log(`  Fetching reviews...`);
      const reviewsQuery = `
        query($searchQuery: String!) {
          search(query: $searchQuery, type: ISSUE, first: 100) {
            issueCount
            edges {
              node {
                ... on PullRequest {
                  number
                  title
                  url
                  updatedAt
                }
              }
            }
          }
        }
      `;

      const reviewSearchQuery = `repo:${repo.owner}/${repo.name} is:pr reviewed-by:${username} created:>=${sinceDate}`;

      try {
        const reviewsResponse = await this.octokit.graphql(reviewsQuery, { searchQuery: reviewSearchQuery });

        if (reviewsResponse.search && reviewsResponse.search.edges) {
          for (const edge of reviewsResponse.search.edges) {
            const pr = edge.node;
            contributions.reviews.push({
              pr_number: pr.number,
              pr_title: pr.title,
              reviewed_at: pr.updatedAt,
              url: pr.url,
            });
          }
          console.log(`  Found ${contributions.reviews.length} reviews`);
        }
      } catch (error) {
        console.warn(`  Could not fetch reviews (this is optional): ${error.message}`);
      }

    } catch (error) {
      console.error(`Error fetching data for ${username} in ${repo.owner}/${repo.name}:`, error.message);
    }

    return contributions;
  }

  async fetchAllContributions() {
    const cache = await this.loadCache();
    const now = new Date().toISOString();
    const allContributions = {};

    // Collect all contributors from all cohorts
    const allContributorsList = [];
    for (const cohortKey of Object.keys(this.contributors.cohorts)) {
      const cohort = this.contributors.cohorts[cohortKey];
      for (const contributor of cohort.contributors) {
        allContributorsList.push({
          cohortKey,
          cohort,
          contributor,
        });
      }
    }

    // Determine which contributors to process
    let contributorsToProcess = allContributorsList;
    const totalContributors = allContributorsList.length;
    const totalBatches = Math.ceil(totalContributors / this.batchSize);

    if (this.batchNumber !== null) {
      // Process specific batch
      const startIdx = (this.batchNumber - 1) * this.batchSize;
      const endIdx = Math.min(startIdx + this.batchSize, totalContributors);
      contributorsToProcess = allContributorsList.slice(startIdx, endIdx);

      console.log(`\nProcessing batch ${this.batchNumber}/${totalBatches} (contributors ${startIdx + 1}-${endIdx} of ${totalContributors})\n`);
    } else if (this.batchAll) {
      console.log(`\nProcessing all ${totalBatches} batches (${totalContributors} contributors total)\n`);
    }

    // Initialize cohort structures
    for (const cohortKey of Object.keys(this.contributors.cohorts)) {
      const cohort = this.contributors.cohorts[cohortKey];
      if (!allContributions[cohortKey]) {
        allContributions[cohortKey] = {
          name: cohort.name,
          start_date: cohort.start_date,
          contributors: {},
        };
      }
    }

    // Process in batches if batch-all mode
    if (this.batchAll) {
      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        const batchNum = batchIdx + 1;
        const startIdx = batchIdx * this.batchSize;
        const endIdx = Math.min(startIdx + this.batchSize, totalContributors);
        const batchContributors = allContributorsList.slice(startIdx, endIdx);

        console.log(`\n=== Batch ${batchNum}/${totalBatches} (contributors ${startIdx + 1}-${endIdx}) ===\n`);

        await this.processBatch(batchContributors, allContributions, cache, now);

        // Check rate limit and wait if needed
        await this.waitIfNeededForRateLimit();

        // Add delay between batches (except for the last one)
        if (batchNum < totalBatches) {
          console.log(`\nBatch ${batchNum} complete. Waiting ${BATCH_DELAY_MS / 1000}s before next batch...\n`);
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }
    } else {
      // Process single batch or all at once
      await this.processBatch(contributorsToProcess, allContributions, cache, now);
    }

    await this.saveCache(cache);
    return allContributions;
  }

  async processBatch(contributorsToProcess, allContributions, cache, now) {
    for (const { cohortKey, cohort, contributor } of contributorsToProcess) {
      console.log(`Fetching data for ${contributor.name} (${contributor.github})`);

      const userContributions = {
        name: contributor.name,
        github: contributor.github,
        repositories: {},
      };

      for (const repo of this.repositories.repositories) {
        const cacheKey = await this.getCacheKey(repo, contributor.github, 'all');

        let finalContributions;

        if (this.shouldFetch(cacheKey, cache)) {
          console.log(`  Fetching fresh data for ${repo.name}...`);
          // If force mode, fetch all data from beginning; otherwise fetch incrementally
          const lastFetch = this.force ? SINCE_DATE : (cache[cacheKey] || SINCE_DATE);

          const newContributions = await this.fetchUserContributions(
            contributor.github,
            repo,
            lastFetch
          );

          // Load cached contributions and merge (skip merge if force mode and fetching all data)
          const cachedContributions = this.force ? null : await this.loadCachedContributions(contributor.github, repo);
          finalContributions = this.mergeContributions(cachedContributions, newContributions);

          // Save merged contributions to cache
          await this.saveCachedContributions(contributor.github, repo, finalContributions);

          cache[cacheKey] = now;
        } else {
          const hoursSince = ((new Date() - new Date(cache[cacheKey])) / (1000 * 60 * 60)).toFixed(1);
          console.log(`  Using cached data for ${repo.name} (fetched ${hoursSince}h ago)`);
          finalContributions = await this.loadCachedContributions(contributor.github, repo);
        }

        userContributions.repositories[`${repo.owner}/${repo.name}`] = {
          category: repo.category,
          contributions: finalContributions,
        };
      }

      allContributions[cohortKey].contributors[contributor.github] = userContributions;
    }
  }

  async generateStats(contributions) {
    const stats = {
      generated_at: new Date().toISOString(),
      since_date: SINCE_DATE,
      summary: {
        total_contributors: 0,
        total_commits: 0,
        total_prs: 0,
        total_merged_prs: 0,
        total_reviews: 0,
      },
      leaderboard: {
        overall: [],
        by_cohort: {},
      },
      pr_review_metrics: {
        average_review_time_hours: 0,
        top_reviewers: [],
        repositories_by_review_time: [],
      },
      contributions,
    };

    // Calculate stats
    const contributorStats = [];

    for (const cohortKey of Object.keys(contributions)) {
      const cohort = contributions[cohortKey];
      stats.leaderboard.by_cohort[cohortKey] = [];

      for (const username of Object.keys(cohort.contributors)) {
        const contributor = cohort.contributors[username];
        let userStats = {
          name: contributor.name,
          github: contributor.github,
          cohort: cohort.name,
          commits: 0,
          prs: 0,
          merged_prs: 0,
          reviews: 0,
          score: 0,
        };

        for (const repoKey of Object.keys(contributor.repositories)) {
          const repo = contributor.repositories[repoKey];
          userStats.commits += repo.contributions.commits.length;
          userStats.prs += repo.contributions.prs.length;
          userStats.merged_prs += repo.contributions.prs.filter(pr => pr.merged_at).length;
          userStats.reviews += repo.contributions.reviews.length;
        }

        // Simple scoring: commits + PRs*5 + merged PRs*10 + reviews*3
        userStats.score = userStats.commits + 
                         userStats.prs * 5 + 
                         userStats.merged_prs * 10 + 
                         userStats.reviews * 3;

        contributorStats.push(userStats);
        stats.leaderboard.by_cohort[cohortKey].push(userStats);
      }
    }

    // Sort leaderboards
    stats.leaderboard.overall = contributorStats
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);

    for (const cohort of Object.keys(stats.leaderboard.by_cohort)) {
      stats.leaderboard.by_cohort[cohort].sort((a, b) => b.score - a.score);
    }

    // Update summary
    stats.summary.total_contributors = contributorStats.length;
    stats.summary.total_commits = contributorStats.reduce((sum, c) => sum + c.commits, 0);
    stats.summary.total_prs = contributorStats.reduce((sum, c) => sum + c.prs, 0);
    stats.summary.total_merged_prs = contributorStats.reduce((sum, c) => sum + c.merged_prs, 0);
    stats.summary.total_reviews = contributorStats.reduce((sum, c) => sum + c.reviews, 0);

    // Calculate reviewer metrics
    const reviewerMap = new Map();
    const mergerMap = new Map();
    const repoReviewTimes = {};
    let totalReviewTimeHours = 0;
    let reviewTimeCount = 0;

    for (const cohortKey of Object.keys(contributions)) {
      const cohort = contributions[cohortKey];
      for (const username of Object.keys(cohort.contributors)) {
        const contributor = cohort.contributors[username];
        for (const repoKey of Object.keys(contributor.repositories)) {
          const repo = contributor.repositories[repoKey];

          // Track review times by repository
          if (!repoReviewTimes[repoKey]) {
            repoReviewTimes[repoKey] = {
              total_time: 0,
              count: 0,
              merged_count: 0,
            };
          }

          for (const pr of repo.contributions.prs) {
            // Aggregate reviewer stats
            if (pr.reviews && pr.reviews.length > 0) {
              for (const review of pr.reviews) {
                const reviewer = review.reviewer;
                if (!reviewerMap.has(reviewer)) {
                  reviewerMap.set(reviewer, {
                    reviewer,
                    review_count: 0,
                    approved_count: 0,
                    total_time_to_review: 0,
                    review_time_count: 0,
                  });
                }
                const reviewerStats = reviewerMap.get(reviewer);
                reviewerStats.review_count++;
                if (review.state === 'APPROVED') {
                  reviewerStats.approved_count++;
                }
              }
            }

            // Aggregate merger stats (exclude self-merges)
            if (pr.merged_by && pr.merged_by !== pr.author) {
              if (!mergerMap.has(pr.merged_by)) {
                mergerMap.set(pr.merged_by, {
                  merger: pr.merged_by,
                  merge_count: 0,
                });
              }
              mergerMap.get(pr.merged_by).merge_count++;
            }

            // Calculate average review times
            if (pr.time_to_first_review_hours !== null) {
              totalReviewTimeHours += pr.time_to_first_review_hours;
              reviewTimeCount++;

              repoReviewTimes[repoKey].total_time += pr.time_to_first_review_hours;
              repoReviewTimes[repoKey].count++;

              // Add to first reviewer's time stats
              if (pr.reviews && pr.reviews.length > 0) {
                const firstReviewer = pr.reviews[0].reviewer;
                const reviewerStats = reviewerMap.get(firstReviewer);
                if (reviewerStats) {
                  reviewerStats.total_time_to_review += pr.time_to_first_review_hours;
                  reviewerStats.review_time_count++;
                }
              }
            }

            if (pr.merged_at) {
              repoReviewTimes[repoKey].merged_count++;
            }
          }
        }
      }
    }

    // Calculate average review time
    stats.pr_review_metrics.average_review_time_hours =
      reviewTimeCount > 0 ? totalReviewTimeHours / reviewTimeCount : 0;

    // Sort and format top reviewers
    stats.pr_review_metrics.top_reviewers = Array.from(reviewerMap.values())
      .map(r => ({
        ...r,
        avg_time_to_review_hours: r.review_time_count > 0
          ? r.total_time_to_review / r.review_time_count
          : null,
        approval_rate: r.review_count > 0
          ? (r.approved_count / r.review_count) * 100
          : 0,
      }))
      .sort((a, b) => b.review_count - a.review_count)
      .slice(0, 20)
      .map(({ total_time_to_review, review_time_count, ...rest }) => rest);

    // Top mergers
    stats.pr_review_metrics.top_mergers = Array.from(mergerMap.values())
      .sort((a, b) => b.merge_count - a.merge_count)
      .slice(0, 20);

    // Format repositories by review time
    stats.pr_review_metrics.repositories_by_review_time = Object.entries(repoReviewTimes)
      .map(([repo, data]) => ({
        repository: repo,
        avg_review_time_hours: data.count > 0 ? data.total_time / data.count : 0,
        pr_count: data.count,
        merged_count: data.merged_count,
      }))
      .sort((a, b) => b.pr_count - a.pr_count);

    return stats;
  }

  async run() {
    await this.loadConfig();
    console.log('Fetching contributions...');
    
    const contributions = await this.fetchAllContributions();
    console.log('Generating stats...');
    
    const stats = await this.generateStats(contributions);
    
    // Save results
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(
      path.join(OUTPUT_DIR, 'contributions.json'),
      JSON.stringify(stats, null, 2)
    );
    
    console.log('Done! Stats saved to data/contributions.json');
  }
}

// Run if called directly
if (require.main === module) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Please set GITHUB_TOKEN environment variable');
    process.exit(1);
  }

  // Parse CLI arguments
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const batchArg = args.find(arg => arg.startsWith('--batch='));
  const batchNumber = batchArg ? parseInt(batchArg.split('=')[1]) : null;
  const batchAll = args.includes('--batch-all');
  const batchSizeArg = args.find(arg => arg.startsWith('--batch-size='));
  const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1]) : undefined;

  if (force) {
    console.log('Force mode enabled - fetching fresh data\n');
  }

  if (batchNumber !== null) {
    console.log(`Batch mode: Processing batch #${batchNumber}\n`);
  } else if (batchAll) {
    console.log('Batch-all mode: Processing all batches sequentially\n');
  }

  const fetcher = new ContributionFetcher(token, force, batchNumber, batchAll, batchSize);
  fetcher.run().catch(console.error);
}

module.exports = ContributionFetcher;