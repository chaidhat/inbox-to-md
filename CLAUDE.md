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

### One authentication surface, two auth methods

`inbox-to-md auth` is the only authentication interface, and it is non-interactive: flags in, JSON on stdout, JSON errors on stderr, never a prompt. Do not add a TUI or an interactive fallback. The single unavoidable human step is the Google consent screen during `add --auth oauth` / `reauth`, and even that prints its URL to stderr so stdout stays machine-readable.

Accounts authenticate with either a password or Google OAuth, and the two must stay equivalent in everything except how the credential is obtained: field validation, IMAP verification before saving, persistence, and add/edit/delete behavior. Keep that shared behavior in the shared modules — `config.ts` (schema and migrations), `account-auth.ts` (validation and verification), `imap.ts` (the only place an account becomes a connection) — rather than branching inside the command. When you change one method, exercise the other, and update both `README.md` and `SKILL.md`, which document them together.
