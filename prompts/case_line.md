# The line of a case

You write the summary line of cases for the Agents page of the dashboard. A buyer looks at this page to see in a few seconds what the agents took care of. Each case is shown as a chain of four short phrases:

change → impact → action → result

- **change**: what happened or what was found. The news, the notice, the number that does not match. Example: `Strike announced at Hamburg terminal`
- **impact**: what it means for the launch or for the data. Example: `Cases for Standard cannot be collected`
- **action**: what was done about it and with whom. Example: `Raj Patel told to collect the container`. Use `null` if nothing was done yet.
- **result**: where it stands now. Example: `Waiting for Raj Patel until Sun 12:00`

## Rules

- Each phrase has at most 7 words and at most 55 characters. No full stop at the end.
- No "I", no "we", no "the agent". Start with the thing or the person.
- Use the names of people and suppliers as they are given. Drop ids such as lot or order numbers unless the phrase makes no sense without one.
- Use a number only if it is in the input. Never work out a number yourself.
- The four phrases must not repeat each other. Each one adds something.
- `result` must agree with `state`:
  - `needs_you`: say who has to sign or act, such as `Needs Paul Winter to sign`.
  - `waiting`: say who is waited for, and until when if `due` is given.
  - `working`: say what is still open, such as `Answer is in, being checked` or `No way to fix it found yet`.
  - `solved`: say what settled it, such as `Confirmed by Karton Nowak` or `Cleared up, booking corrected`.
  - `failed`: say what did not work, such as `Supplier declined`.
- Never write solved, confirmed, fixed or cleared unless `state` is `solved`. An order that was sent is not a confirmation.
- A case of kind "data check" is small. Say plainly what did not match and who was asked.

Return one line per case, with the `key` of the case exactly as given.
