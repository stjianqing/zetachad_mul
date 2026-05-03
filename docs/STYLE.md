# Voice & Tone

ZetaChad's UI copy is **tongue-in-cheek and acerbic**. Think: a friend who roasts you for missing 7×8 but is genuinely glad you showed up.

## The rules

1. **Punch down at the math, not the player.** "The RNG hated you" is fine. "You're bad at math" is not.
2. **No AI tells.** No em-dashes for drama, no "Now you know", no over-explaining. If the joke needs a setup, cut the joke.
3. **Concrete > abstract.** "kept getting 2+2" beats "easy questions". Name a specific number, op, or scenario.
4. **No baseball, no American sports analogies.** We're Singaporean. If you're tempted, reach for something universal (RNG, luck, weather) or skip the analogy.
5. **Singlish sparingly.** "lah" / "leh" can land but feel forced if every line has them. Use when the rhythm calls for it, not as decoration.
6. **Short.** A caption is one sentence, two max. A toast is a half-sentence. If it doesn't fit on one line on mobile, cut.
7. **Functional copy stays functional.** Error messages, form labels, button text — don't joke. "Submit failed: connection refused" is right. "Oops! Looks like the gremlins ate your submit 😅" is wrong.

## Where the tone shows up

- **Captions / explainers** under tables and charts (leaderboard Diff caption is the canonical example).
- **Empty states** ("No scores yet — be the first" is too dry. Better: "No scores yet. The bar is on the floor.")
- **Score-screen post-notes** ("Custom runs aren't eligible for the leaderboard." → keep the fact, can sharpen the delivery.)
- **Page taglines / headers** if/when added.

## Where the tone does NOT show up

- Form validation errors
- Auth flows ("Wrong password" stays "Wrong password")
- Admin panel (it's a tool, not a product surface)
- API responses

## Examples

| ❌ Too AI / too earnest | ✅ Tone |
|---|---|
| "Great job! You scored 42 points!" | "42. Not bad." |
| "The difficulty score reflects the average complexity of your problem set, allowing for fair comparison between runs." | "That's Diff — average puzzle pain, 0–10. Two 50s aren't the same 50 if one guy kept getting 2+2." |
| "No data available." | "Nothing here yet." |
| "Please log in to submit your score to the leaderboard." | "Log in to submit. Otherwise this run is just for you." |

## Reference

- The leaderboard caption (`client/leaderboard.html`) is the current canonical example of the tone.
- When adding new copy, draft 3 versions, pick the one that sounds most like a person and least like a product manager.
