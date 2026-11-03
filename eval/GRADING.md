# Grading rules for the generated answers

Written **before** grading. The grades are saved in the run file (`eval/runs/<run>-answers.json`, fields `grade`
and `grade_note`), from the grading form of the opened run in the *Evaluation* tab.

Graded run: `2026-11-02T22-20-14-kestrel-c1200-o10-k5-answers.json` (configuration C: 1,200 / 10 % / top-5) · question set: kestrel · graded by: Bahjat Khouzam, Chris El Hazzouri · date: 3 November 2026

## Scale (from the course)

| Grade | Meaning |
|---|---|
| **correct** | gives all the key facts of the expected answer, nothing wrong, and is supported by the cited chunks |
| **partial** | some key facts are right, but at least one is missing; nothing it says is wrong |
| **wrong** | at least one key fact is wrong or contradicts the expected answer, or it says "not found" when the answer is in the corpus |
| **unsupported** | says things the referenced chunks do not say |

Unanswerable questions: **correct** means the app says "not in the documents"; answering anyway is **wrong**, however plausible.

## Our rules

1. Key facts are the numbers, names and steps in the expected answer (for example 20 %, 60 days, both IP addresses, the team and the channel). Extra correct detail does not lower the grade.
2. Versions: an answer that gives the 2025 numbers as the current rule is **wrong**. Mentioning the old 2025 value as "the previous policy", next to the correct 2026 value, is fine.
3. A correct answer that cites a chunk which does not contain what it says is **unsupported**: the user could not verify it.
4. For split and two-hop answers, missing one part (for example the suspension at 60 days, or the channel) is **partial**.
5. If the generation failed with an error, the answer is not graded; we re-run it.
6. For every answer that is not correct, we note whether the evidence was in the chunks sent to the model (generation failure) or not (retrieval failure).

## After grading: retrieval failure or generation failure?

For each answer that is not correct, the grading form shows whether the evidence was in the chunks sent to the model.
Not there → retrieval failure. There → generation failure.
