# Failure questions

Status: draft

A person must review these questions. Then change the status line above to `Status: reviewed`.
Until then, the console shows each answer as an answer to draft questions.

Basalt asks each question below about each flagged criterion of the "Explain failures"
request. A flagged criterion has a plan warning. The answers are hypotheses for a person. They
never change an answer, a review or a total.

Keep the four question IDs and their sequence. Write one question under each ID. Basalt hashes
the questions into each request, so a change to this file changes the request and its preview.

## prompt_gap

Does the builder prompt fail to ask for the behavior that this criterion checks? Consider only
the builder prompt and the public roles, because the builder reads only them. Answer yes when a
builder that follows the prompt exactly can still fail this criterion, for example because the
criterion needs a name, a value, a timing or an object that the prompt does not state.

## observation_gap

Does the private plan fail to observe the behavior that this criterion describes? Answer yes
when the observations of the plan cannot show the behavior as the criterion states it, for
example because a phase ends before the behavior occurs, a fact reads a different object or
property, or the check compares the observed value with a value that the criterion does not
state.

## gaming

Do the observations show that a build can pass this check without the behavior that the
criterion describes? Answer yes when the check passes on output that only imitates the
behavior, for example a fixed value, a label, a passive object or the unchanged starting files.

## infrastructure

Did Studio, the recorder or the Basalt connector cause the observed answers, and not the
builds? Answer yes when the observations show a failure to start, to load the build, to record
or to read a value, for example the same missing or default value in each build.
