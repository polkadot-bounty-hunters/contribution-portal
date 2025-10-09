#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const { Octokit } = require('@octokit/rest');
const { throttling } = require('@octokit/plugin-throttling');

const MyOctokit = Octokit.plugin(throttling);

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const OUTPUT_DIR = path.join(__dirname, '..', 'data');
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const SINCE_DATE = '2022-07-01T00:00:00Z';

class ContributionFetcher {
  constructor(token) {
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

  async fetchUserContributions(username, repo, since) {
    const contributions = {
      commits: [],
      prs: [],
      issues: [],
      reviews: [],
    };

    try {
      // Fetch commits
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

      // Fetch PRs
      const prs = await this.octokit.paginate(this.octokit.search.issuesAndPullRequests, {
        q: `type:pr author:${username} repo:${repo.owner}/${repo.name} created:>=${since}`,
        per_page: 100,
      });

      for (const pr of prs) {
        const prDetail = await this.octokit.pulls.get({
          owner: repo.owner,
          repo: repo.name,
          pull_number: pr.number,
        });

        contributions.prs.push({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          created_at: pr.created_at,
          closed_at: pr.closed_at,
          merged_at: prDetail.data.merged_at,
          url: pr.html_url,
          ready_for_review_at: prDetail.data.draft ? null : pr.created_at,
          first_review_at: null, // Will be populated later
        });
      }

      // Fetch reviews
      const reviews = await this.octokit.paginate(this.octokit.search.issuesAndPullRequests, {
        q: `type:pr reviewed-by:${username} repo:${repo.owner}/${repo.name} created:>=${since}`,
        per_page: 100,
      });

      contributions.reviews = reviews.map(review => ({
        pr_number: review.number,
        pr_title: review.title,
        reviewed_at: review.updated_at,
        url: review.html_url,
      }));

    } catch (error) {
      console.error(`Error fetching data for ${username} in ${repo.owner}/${repo.name}:`, error.message);
    }

    return contributions;
  }

  async fetchAllContributions() {
    const cache = await this.loadCache();
    const now = new Date().toISOString();
    const allContributions = {};

    for (const cohortKey of Object.keys(this.contributors.cohorts)) {
      const cohort = this.contributors.cohorts[cohortKey];
      allContributions[cohortKey] = {
        name: cohort.name,
        start_date: cohort.start_date,
        contributors: {},
      };

      for (const contributor of cohort.contributors) {
        console.log(`Fetching data for ${contributor.name} (${contributor.github})`);
        
        const userContributions = {
          name: contributor.name,
          github: contributor.github,
          repositories: {},
        };

        for (const repo of this.repositories.repositories) {
          const cacheKey = await this.getCacheKey(repo, contributor.github, 'all');
          const lastFetch = cache[cacheKey] || SINCE_DATE;
          
          const contributions = await this.fetchUserContributions(
            contributor.github,
            repo,
            lastFetch
          );

          userContributions.repositories[`${repo.owner}/${repo.name}`] = {
            category: repo.category,
            contributions,
          };

          cache[cacheKey] = now;
        }

        allContributions[cohortKey].contributors[contributor.github] = userContributions;
      }
    }

    await this.saveCache(cache);
    return allContributions;
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

  const fetcher = new ContributionFetcher(token);
  fetcher.run().catch(console.error);
}

module.exports = ContributionFetcher;