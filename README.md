# PBA Nation Contribution Portal

Track and showcase contributions from PBA graduates across the Polkadot ecosystem.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Add contributors to `config/contributors.yaml`

3. Set up GitHub token:
```bash
export GITHUB_TOKEN=your_github_token_here
```

4. Fetch contribution data:
```bash
npm run fetch-data
```

5. Run development server:
```bash
npm run dev
```

## Deployment

The site automatically deploys via GitHub Actions when you push to main. The workflow:
- Runs nightly at 2 AM UTC
- Fetches latest contribution data
- Commits the data
- Builds and deploys to GitHub Pages

## Configuration

- `config/contributors.yaml` - Add PBA graduates here, grouped by cohort
- `config/repositories.yaml` - Configure which repositories to track

## Features

- **Dashboard**: Overview of all contributions
- **Leaderboard**: Global rankings and scoring
- **Cohort Competition**: Compare cohorts against each other
- **PR Review Analytics**: Track review times (coming soon)
- **Mentor Program**: Connect graduates with mentors

## Data Collection

The system tracks:
- Commits (since July 2022)
- Pull Requests (created, merged status)
- Code Reviews
- Issues (coming soon)

Scoring formula: commits + PRs×5 + merged PRs×10 + reviews×3