---
name: log-prompt
description: Record meaningful AI-assisted work in PROMPTS.md (goal, prompt summary, what was kept, what was corrected or rejected). Use at the end of a task where AI generated a design or significant code.
---

# Log prompt

The challenge requires a transparent record of AI usage.
1. Open `PROMPTS.md` and find the last row number in the table.
2. Append one row:
   `| <n+1> | <goal> | "<prompt summary, one line>" | <what was kept> | <what was corrected/rejected and why> |`
3. Be honest and specific in the last column (e.g. "rejected read-then-write reservation; replaced with
   conditional UPDATE"). Leave it empty only if nothing was changed.
4. Write in English. Don't paste whole prompts or code.
5. Commit with the related change, or alone as `docs: log prompt <n+1>`.
