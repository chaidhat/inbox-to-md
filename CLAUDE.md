# CLAUDE.md

This file provides guidance to Claude-style agents working in this repository.

## Write good code.

We always write good code, and YOU (Claude Code) must ALWAYS write good code -- the quality a professional software engineer would be proud to ship and a teammate would be happy to maintain. Prioritize this over completion time or token saving: we'd rather wait longer for good code than have you quickly produce bad code.

What is good code?

### Chai's Law of Good Coding

This is in order of importance, if any rule contradicts one another, always adhere to the lower number rule first. When making engineering decisions, please reference these rules explicitly in your plan. (e.g., "Chai's Law of Good Coding #1")

1. code must be **correct, reliable & secure** -- all edge cases should be accounted for. Performance also falls under this category, however it is important to not prematurely optimize. Security and defensive coding falls under this category too. Fallbacks don't have to be elaborate but should at least fail-closed and keep a failure knowable to the user or developer (not silently swallowed), without leaking security or PHI. Storing user data securely is of utmost importance.
2. code must be **maintainable** -- a human who doesn't know the codebase who comes to adjust your code must be able to know what they are doing. the core tactic is high cohesion, low coupling: related behaviors grouped together inside the same module, different modules kept independent. Don't Repeat Yourself (DRY) follows from this, but don't over-apply it -- the wrong abstraction costs more than a little duplication, so prefer duplicating until the shared shape is obvious rather than coupling two things that only look the same today.
3. code must be **consistent** -- should be consistent with the other code in the repository. If you implement a flag in a CLI script, then it should look like how other flags are implemented inside a CLI script. This is why we created the rest of the document below. One exception: match local conventions, but don't copy a clear anti-pattern just because it's already there -- flag it instead of propagating it.

### Keep authentication surfaces in sync

`inbox-to-md auth` is the interactive interface and `inbox-to-md authcli` is the non-interactive interface for agents and scripts. If you update either one, update and test the other too. Account fields, validation, IMAP verification, persistence, and add/edit/delete behavior must stay equivalent; keep shared behavior in shared modules. Interface-specific presentation may differ: `auth` uses a TUI, while `authcli` uses flags and JSON output.
