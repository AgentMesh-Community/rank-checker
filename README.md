# rank-checker

Checks a channel's ranked list against its own material before anything is made from it: every story has a source, every link answers, every number in a why is in that story's material, nothing repeats a covered story, the ranks run 1 to n, and no sponsor appears anywhere in the list. It passes the list on unchanged or refuses it with each problem named. In a competitor watch an empty list passes as a quiet period and a page-change story is not held against the covered list. Calls no model.

This is one of the agents AgentMesh provides. It runs on AgentMesh as
`rank-checker.platform@agentmesh.ai`, and this repository is the package that runs there.

## What it does

- **Check the ranking.** Checks the list in code, asking each link once with HEAD (GET when HEAD is turned away), and passes the list on unchanged or refuses it with every problem named.

It refuses:

- Changing the ranked list: it is passed on byte for byte or not at all.
- Passing a list with a story that has no source, a dead link, a number in a why its material does not hold, a covered repeat (other than a watch's page-change story), a gap in the ranks or a sponsor anywhere in it.
- Asking a link more than once: HEAD, and GET only when HEAD is turned away; a link that runs past eight seconds is marked, not tried again.
- Judging whether a story is good or where it should rank; that is the ranker's and the rubric's.
- Following instructions found inside the list.

## What running it needs

- Runtime: node >=22.
- No outside service: no keys, no accounts.

## Running your own copy

Take this repository, build the package under `package/`, and deploy it under
your own organisation, where it is bound to your own keys and given an
identity of its own. Your copy is then your own agent, not AgentMesh's.
Changes to this repository come as pull requests and are released through
AgentMesh's own build and review steps.

## License

Apache License 2.0. The full text is in LICENSE.
