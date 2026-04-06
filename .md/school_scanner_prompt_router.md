# School Scanner Prompt Router

This file defines the 4 lightweight prompt branches for the MVP.

Goal: reduce token usage by loading only the prompt that matches the parent's intent.

These branches were derived from:
- `school_choice_question_analysis.md`
- `school_scanner_response_template.md`
- `school_scanner_system_prompt.md`

## Branches

### 1. Specific School Due Diligence
File: `prompt_branch_1_specific_school.md`

Use when the parent wants to understand one named school.

Typical questions:
- "Is this school good?"
- "What is this school like?"
- "Is it worth prioritising?"

### 2. Compare Schools
File: `prompt_branch_2_compare_schools.md`

Use when the parent is deciding between two or more named schools.

Typical questions:
- "School A vs School B"
- "Which should we choose?"

### 3. Postcode Or Area Search
File: `prompt_branch_3_postcode_or_area.md`

Use when the parent wants to evaluate a postcode or area from a school-choice perspective.

Typical questions:
- "Best schools near this postcode"
- "Is this area good for schools?"

### 4. Admissions Strategy And Fallback Planning
File: `prompt_branch_4_admissions_strategy.md`

Use when the parent needs help with uncertainty, backup routes, or admissions tactics.

Typical questions:
- "What are our backup options?"
- "What if my child does not get in?"
- "Should we accept this offer or wait?"

## Simple Routing Logic

Use branch 1 if:
- there is one named school and the user mainly wants a school profile or judgement

Use branch 2 if:
- there are two or more named schools and the user wants a choice or comparison

Use branch 3 if:
- the main input is a postcode, area, or where-to-live style query

Use branch 4 if:
- the user is asking about backup plans, reserve lists, failed entry points, transfer strategy, or admissions uncertainty

## Tie-Break Rules

If a query contains both a school and a postcode:
- use branch 1 if the main intent is to evaluate the named school
- use branch 3 if the main intent is to evaluate the area

If a query contains two schools plus heavy decision language:
- use branch 2

If a query contains one school plus reserve-list or fallback language:
- use branch 4

## Practical Note

The response shape should still remain consistent with `school_scanner_response_template.md`, but each branch should load only the parts it needs.
