# Grading rules for the generated answers

Written **before** grading. The grades are saved in the run file (`eval/runs/<run>-answers.json`, fields `grade`
and `grade_note`), from the grading form of the opened run in the *Evaluation* tab.

Graded run: _(file name)_ · question set: _(kestrel or vellora)_ · graded by: _(names)_ · date: _(date)_

## Scale (from the course)

| Grade | Meaning |
|---|---|
| **correct** | |
| **partial** | |
| **wrong** | |
| **unsupported** | says things the referenced chunks do not say |

Unanswerable questions: **correct** means the app says "not in the documents"; answering anyway is **wrong**, however plausible.

## Our rules

_TO WRITE (team): your own rules, before you grade. For example: what counts as a "key fact" for each question;
whether a correct answer that also cites the superseded 2025 policy is correct or partial; whether an answer that
is right but cites the wrong chunk is correct or unsupported; what you do when the generation failed._

## After grading: retrieval failure or generation failure?

For each answer that is not correct, the grading form shows whether the evidence was in the chunks sent to the model.
Not there → retrieval failure. There → generation failure.
