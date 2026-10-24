# Agent rules

## Respond before changing code

When the user asks a question, describes a problem, or talks through an idea, answer in chat only. Do not edit, create, or delete project files.

The reply has three parts:

1. **Approach** — the concrete plan for the change or the answer.
2. **Reason** — why that plan fits this codebase and this request.
3. **Sequence diagram** — a Mermaid `sequenceDiagram` that names the real actors (user, frontend, backend, database, external services) and shows the messages in order.

Change code, configuration, or other project files only when the user explicitly asks to implement the change. Treat wording such as "implement", "do it", "apply this", "make the change", "go ahead", or "update the file" as that request. A question, a bug report, or a design comment is a request for the three-part reply above.
