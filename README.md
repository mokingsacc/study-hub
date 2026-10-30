# Study Hub

Your own Study Hub: subjects, a map of your topics from weakest to strongest, flashcards, results, past papers,
mnemonics, a library of your notes, and your study days. It runs on your own free Cloudflare account, and your own
Claude (on your Claude plan) teaches you, tests you and changes the hub when you ask.

## Set it up (about 10 minutes)

1. Make a free GitHub account and a free Cloudflare account if you do not have them.
2. Press the button:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mokingsacc/study-hub)

3. On the deploy page, fill in the two secrets:
   - **SETUP_CODE**: a phrase only you know (12 or more characters). You type it once, in step 5.
   - **PLATFORM_SECRET**: 32 or more random characters. Any long random string works.
   - Check the **deploy command** says `npm run deploy` (it sets up the database, then deploys). If it says
     `npx wrangler deploy`, change it.
   - Keep the suggested names for the database, file store and search index (they start with my-study-hub).
   - If it asks about the search index (Vectorize): **dimensions 384**, **metric cosine**. They must match the
     model the hub searches your notes with, and cannot be changed later.
4. Wait for the deploy to finish, then open your new address (it ends in `.workers.dev`).
5. The page asks for your setup code, your name, what you study for, and a password. That makes your account; it
   is the only one, and nobody else can make one after it.
6. In Settings, add your Study Hub to your own Claude (a custom connector), then say to Claude:
   **"Set up my Study Hub with me"**. It asks about your subjects, exam boards and latest results, and suggests
   what to switch on.

Moving from a shared Study Hub? In step 5, open "Moving from another Study Hub?" and choose the file from
"Download my data" on the old one.

## Change it yourself

This is your copy: your own Claude Code can fix and build things in it. Open this repository with Claude Code and
say what you want ("the map labels are too small on my phone", "add a timer to flashcards"). CLAUDE.md tells it how
the code fits together, how to test, and how to deploy. Every push to your repository redeploys your hub.

## Free plan

It fits Cloudflare's free plan for one person; see docs/free-plan.md for the numbers and what to watch.

## Your data

Your data lives only in your Cloudflare account. "Download my data" in Settings gives you all of it as a file.
