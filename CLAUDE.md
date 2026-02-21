# Remote - ChatGPT Browser Automation

## ChatGPT CLI Tool

A CLI tool (`chatgpt`) for sending questions to ChatGPT and reading responses via a Chrome browser session connected through the Chrome DevTools Protocol.

Available globally as `chatgpt` (symlinked to `~/.local/bin/chatgpt`).

### Setup

Chrome must be running with remote debugging enabled:

```
chatgpt launch
```

Then open https://chatgpt.com in the browser and log in.

### Commands

```
chatgpt launch                           Kill & restart Chrome with debug port
chatgpt status                           Check if Chrome debug port is active
chatgpt send "question"                  Send question, print response
chatgpt send "question" --raw            Response only, no status messages
chatgpt send "question" --new-chat       Start a fresh chat first
chatgpt send "question" -o result.md     Save response to markdown file
chatgpt send "question" --no-prompt      Skip formatting instructions
chatgpt read                             Read last response from browser
chatgpt read N                           Read last N responses
chatgpt read --all                       Read all responses in current chat
chatgpt read -o notes.md                 Save to markdown file
chatgpt read --all -o full-chat.md       Export entire chat
```

### When to use

- To ask ChatGPT for a second opinion or alternative approach
- To retrieve math derivations as clean LaTeX markdown
- To pull in responses the user is working on in their ChatGPT browser session
- When the user says "ask ChatGPT..." or "read the ChatGPT response"

### Output format

- Responses are clean markdown with `#`/`##`/`###` headings, `$...$`/`$$...$$` LaTeX math, fenced code blocks, bold, italic, and lists
- A formatting prompt is prepended by default; use `--no-prompt` to skip
- Use `--raw` for output suitable for piping or capturing

### Technical details

- Requires Chrome launched with `--remote-debugging-port=9222 --user-data-dir=/home/jmh/.chrome-debug-profile`
- Uses puppeteer-core to connect via CDP (Chrome DevTools Protocol)
- The wrapper script at `/usr/bin/google-chrome-stable` can silently drop flags; always use `/opt/google/chrome/chrome` directly (handled by `chatgpt launch`)
- Must kill all existing Chrome processes before launching, otherwise new instance hands off to existing session and ignores flags
