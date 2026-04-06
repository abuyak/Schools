# Live Retrieval Architecture

## What "local evidence" meant

Until now, the app has been answering from files already stored in this repo, especially:

- `sources/Oxford/oxford_admissions_merged.csv`
- `sources/Cambridge/cambridge_admissions_merged.csv`

That is only one evidence layer, not the target product.

## Target system

The target School Scanner system should:

1. Take the selected branch and parent question.
2. Build a branch-specific research plan.
3. Search online in real time using primary sources.
4. Rank and filter evidence.
5. Compose the answer in the exact structure required by that prompt branch.

## Retrieval pipeline

### Step 1: Prompt routing

The selected branch determines:

- search queries
- source priority
- answer structure
- what can and cannot be claimed

### Step 2: Live search

For production, the system needs an online search layer, for example:

- official school websites
- government school pages
- Ofsted / ISI
- official admissions documents
- official destination data

### Step 3: Evidence extraction

Each retrieved source should be normalised into:

- source name
- URL
- source type
- claim snippets
- freshness / date
- confidence

### Step 4: Branch-specific answer composition

The answer generator should then follow the selected prompt strictly:

- branch 1: one-school due diligence
- branch 2: comparison and recommendation
- branch 3: area/postcode search
- branch 4: admissions strategy and fallback planning

## Current repo changes

This repo now includes:

- `server/SchoolScanner.LiveRetrieval.psm1`

That module defines:

- branch research plans
- live retrieval status
- a research contract object for the future online retrieval engine

## What is still needed for full production

- a real search provider or search API
- page fetching and parsing
- source deduplication
- citation storage
- answer rendering with links and source cards
- background caching and rate limiting

## Important rule

The product should never silently substitute missing live evidence with invented claims.

If a source is missing, the answer should still follow the prompt structure, but it must say what is known, what is unknown, and what that means for the decision.
