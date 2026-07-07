---
name: IC Diligence Assistant — End User Guide
description: Step-by-step end-user guide for the IC Diligence Assistant. Covers
  deal creation, document upload and tagging best practices, running analysis
  modules, interpreting findings and reports, using the Q&A panel, and setting
  expectations for processing times and output quality. Reference when
  onboarding new users or answering how-to questions.
accessType: on_demand
isEnabled: true
createdAt: 2026-06-30T11:56:27.366Z
---

# IC Diligence Assistant — End User Guide

## What This Tool Does

The IC Diligence Assistant automates deal data room review for Investment Committee preparation. Upload your deal documents, and the system runs 9 specialized AI analysis modules that surface risks, gaps, contradictions, and questions — producing IC-ready reports in minutes instead of days.

---

## Step-by-Step Workflow

### Step 1: Create a Deal

1. From the home screen, click **"+ New Deal"** (top right)
2. Fill in the deal form:
   - **Deal Name** (required) — e.g., "Project Atlas"
   - **Sector** — e.g., "Technology / SaaS", "Healthcare", "Industrials"
   - **Description** (optional) — brief context for the deal
3. Click **Create Deal** — you'll be taken directly to the Deal Dashboard

**Tip:** You can update deal metadata later (Entry EV, Entry Multiple, Equity Check, IC Date) from the dashboard sidebar.

---

### Step 2: Upload Your Data Room

1. In the left sidebar under **"Data Room"**, drag and drop files or click **"browse"**
2. **Accepted file types:** PDF, Excel (.xlsx/.xls), CSV
3. Stage your files, then click **"Upload X files"**
4. Files appear in the Data Room list immediately after upload

#### Tagging Documents (Critical for Quality)

After upload, each document has two dropdowns:

**Source** (who produced it):
- **Sellside** — documents from the seller, banker, or management team
- **PEP** — documents from your firm (Prov Equity Partners)

**Document Type** (what it is):
| Tag | Use For |
|-----|--------|
| **CIM** | Confidential Information Memorandum, management presentations, teasers |
| **IC Memo** | Your firm's internal investment committee memo, deal write-up |
| **Customer Data** | Customer lists, concentration analyses, NPS/CSAT data, churn reports |
| **Consultant Report** | Quality of Earnings (QoE), market studies, vendor due diligence reports |
| **Financial Model** | Excel/CSV financial models, projections, LBO models |
| **Legal** | LOIs, purchase agreements, regulatory filings, compliance documents |
| **Other** | Anything that doesn't fit the above categories |

**Why tagging matters:** The system intelligently routes documents to the modules that need them. A financial model gets sent to the Model Assumptions Stress Test but not to Social & Reputation Intelligence. Mis-tagging reduces analysis quality. Documents tagged "Other" are sent to all modules as a safe default.

#### Best Practices for Document Upload

- **Upload everything you have** — the more complete the data room, the better the analysis. The system can process up to 30 document chunks across all files.
- **Tag accurately** — spend 30 seconds per document getting the tag right. This has the single biggest impact on output quality.
- **PDFs are ideal** — the system renders each page as an image, so charts, tables, and formatting are preserved for the AI to read.
- **Excel files work well** — cell values, formulas, and multi-sheet workbooks are all parsed. Financial models produce excellent results.
- **Large files are fine** — files over 50 MB will show a size warning but will still process. They'll be chunked into segments automatically.

---

### Step 3: Run Analysis Modules

You have two options:

#### Option A: Run Individual Modules

Click **"Run Analysis"** on any module card. Useful when you want results for one specific area.

#### Option B: Run All Modules (Recommended)

Click **"Run All Modules"** (top right). This:
1. Launches all 8 core modules simultaneously
2. Automatically runs Executive Summary once all others complete
3. Shows a confirmation modal listing which modules will run

#### The 9 Modules Explained

| Module | What It Does | When It's Most Valuable |
|--------|-------------|------------------------|
| **Omission Audit** | Finds missing data, absent sections, and gaps vs. PE diligence standards | Early in diligence — identifies what to request from sellers |
| **Narrative vs. Data Check** | Cross-references claims in the CIM/IC Memo against financial data | After receiving both narrative docs and financial models |
| **Blind Spot Scanner** | Surfaces assumptions baked into the thesis that no one has questioned | Before IC — ensures no unexamined assumptions |
| **External Risk Overlay** | Searches the web for regulatory, competitive, and macro risks not in the data room | Any time — brings in external perspective |
| **Social & Reputation Intelligence** | Researches Glassdoor, LinkedIn, X/Twitter, review platforms for reputation signals | After identifying the target company |
| **IC Questions** | Generates the hard questions IC members are likely to ask | Final IC prep — ensures the deal team is ready |
| **Model Assumptions Stress Test** | Tests whether financial model assumptions hold up against available data | After the financial model is in the data room |
| **Diligence Completeness Score** | Scores the data room across 10 standard PE dimensions (0–100%) | Throughout diligence — tracks progress |
| **Executive Summary** | Synthesizes all module outputs into one IC-ready brief | After all other modules complete |

---

### Step 4: Monitor Progress

While modules run, you'll see real-time progress on each card:

- **Turquoise progress bar** — document chunks being analyzed
- **Amber progress bar** — web research iterations (External Risk, Social & Reputation)
- **Coral progress bar** — synthesis/merge step
- **Status messages** — e.g., "Rendering CIM.pdf: page 15/42" or "Research iteration 3 of 10"

The left sidebar's **Analysis Progress** section shows a timeline of which modules are complete.

---

### Step 5: Review Results

Once a module completes, its card shows:

1. **Executive Header** — a 3–4 sentence summary of the key findings
2. **Severity Badges** — counts of Critical, Warning, and Info findings
3. **Three action buttons:**
   - **Details** — expand to see the full findings and report
   - **Re-run** — run the module again (e.g., after adding new documents)
   - **History** — view past runs and compare results

#### Understanding Severity Levels

| Level | Meaning | Action Required |
|-------|---------|----------------|
| 🔴 **Critical** | Material risk to the investment thesis, major gap, or significant contradiction | Must address before IC — request additional information or revise thesis |
| 🟡 **Warning** | Notable concern that warrants attention but may not be deal-breaking | Discuss with the deal team, prepare IC talking points |
| 🔵 **Info** | Observation worth noting; provides context or minor flags | Good to know, use for IC prep and completeness |

#### The Full Report

Click **"View Full Report"** within the Details panel to see the complete markdown report. Each module's report follows a tailored structure. For example:

- **Omission Audit:** Critical Omissions → Elevated Omissions → Watch Items → Recommended Actions
- **Diligence Completeness:** Scores across 10 PE dimensions with specific gaps per dimension
- **External Risk:** Dynamic categories driven by findings, cross-reference table, source URLs

---

### Step 6: Ask Follow-Up Questions (Q&A Panel)

Below the module grid, the **"Ask the Data Room"** panel lets you ask natural-language questions about your documents:

- Type any question — e.g., "What is the customer concentration?" or "What are the projected EBITDA margins?"
- The system searches across all uploaded documents, selects the most relevant passages, and generates a cited answer
- Answers include **source document references** so you can verify
- Conversation history is maintained for follow-up questions

**Example questions to try:**
- "What is the company's revenue and EBITDA?"
- "Who are the top customers and what are their contract terms?"
- "What are the key risks identified in the materials?"
- "What does the financial model project for the next 3 years?"

**Tip:** The Q&A panel searches over the actual text of your documents. It works best when documents have been uploaded and indexed. For questions about risks and gaps, use the analysis modules instead — they do deeper reasoning.

---

## Setting Expectations

### Processing Times

| Activity | Typical Duration |
|----------|------------------|
| Document upload + processing | 10–30 seconds per file |
| Single module (standard) | 1–3 minutes depending on document volume |
| Single module (web research) | 2–5 minutes (includes live web searches) |
| Run All Modules | 5–10 minutes (modules run in parallel) |
| Q&A question | 5–15 seconds per answer |

### Output Quality

- **Best results** come from complete, well-tagged data rooms. A data room with CIM + IC Memo + Financial Model + QoE gives dramatically better output than a single CIM.
- **The AI reads what you give it.** If a key document is missing, the Omission Audit will flag it — but other modules can't analyze what isn't there.
- **Web research modules** (External Risk, Social & Reputation) work independently of documents — they search the public internet for the target company. They're valuable even with a minimal data room.
- **Re-running after adding documents** is encouraged. The system combines all uploaded files and all previously stored documents for analysis. Adding a financial model after an initial run and re-running will significantly improve the Model Assumptions Stress Test.

### What the Tool Is and Isn't

| ✅ It Is | ❌ It Isn't |
|----------|------------|
| An accelerator that surfaces risks and gaps a human might miss | A replacement for senior judgment or IC discussion |
| A comprehensive first-pass across 10 diligence dimensions | A guarantee that all risks have been found |
| A tool that reads every page of every document simultaneously | A substitute for expert advisors (legal, tax, technical) |
| An IC prep assistant that generates questions and reports | A deal recommendation engine — it doesn't say "invest" or "pass" |

### Tips for Maximum Value

1. **Upload early, upload often** — start with whatever you have, re-run as new docs arrive
2. **Tag everything correctly** — 30 seconds of tagging saves minutes of analysis quality
3. **Run All first, then deep-dive** — get the full picture, then re-run specific modules as needed
4. **Use Q&A for fact-checking** — after reading module reports, verify specific claims via the Q&A panel
5. **Check External Risk and Social & Reputation even for early-stage deals** — they don't need data room docs to provide value
6. **Review the Executive Summary last** — it synthesizes everything, so run it after all other modules
7. **Re-run before IC** — if you've added new documents since the last run, re-run to get updated findings
