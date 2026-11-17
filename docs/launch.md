# Launch kit

Drafts only; no social posts have been sent.

## X post

Your spare computer could be doing useful work.

PocketFleet pairs your machines into a local job queue: text tools, gzip artifacts, and optional Ollama jobs. No cloud account or runtime dependencies.

https://github.com/alfonza1/pocketfleet

Try it. What adapter should come next?

## Optional thread

1. Pair two workers, submit two jobs, and show the live dashboard assigning each once. Record real execution rather than invented fleet metrics.
2. Download and decompress a returned gzip artifact, then show an Ollama-capable worker completing a prompt with an already installed model.
3. Explain the boundaries: this distributes independent jobs, not one model across GPUs. Workers pull bounded, allowlisted tasks; pairing credentials and admin credentials are separate.
4. Invite a concrete contribution: a bounded adapter with cancellation support and tests. Ask for multi-machine TLS setup reports; the release was tested with multiple local workers, not a second physical computer.

## Show HN

Show HN: PocketFleet – a small local job fleet for spare computers

Link the runnable repository, not just the landing page. The [Show HN guidelines](https://news.ycombinator.com/showhn.html) require something people can try, discourage quickly generated one-offs, and prohibit soliciting votes. The maintainer should first use the project personally and be available to discuss implementation and limitations.

## First users and improvements

Start with a real paired-worker demonstration and installation instructions. Ask local-model developers whether dispatching independent Ollama jobs solves their actual workflow. Follow up with reproducible fixes, not repeated launch posts. Prioritize multi-machine TLS onboarding, a bounded image adapter, and backpressure metrics based on reported use.

## Community rules checked November 17, 2026

- **r/LLMDevs:** suitable for the optional local-model dispatch workflow. The [moderator announcement](https://www.reddit.com/r/LLMDevs/comments/1mvuw5x/community_rule_update_clarifying_our/) permits free open-source projects without advance approval, prohibits commercial promotion, and forbids disguised advertising. Disclose authorship and explain the technical behavior. Check current rules before posting.
- **r/SideProject:** a candidate for a working demo and focused feedback request. Its [rules endpoint](https://www.reddit.com/r/SideProject/about/rules/) did not expose rule text to this research client; do not treat that as unrestricted promotion permission. Read the current sidebar/submission instructions before sharing.
- **r/opensource:** excluded from this launch plan. [Recent reporting](https://www.tomshardware.com/tech-industry/artificial-intelligence/reddits-r-opensource-bans-ai-made-and-ai-focused-projects-also-bans-non-english-speakers-sweeping-new-rules-spark-backlash-over-linux-kernel-contributions-and-solo-developers) describes restrictions on AI-assisted and new solo projects. The official rules endpoint did not expose enough text to independently verify the complete policy.

Publish one useful, relevant post at a time, answer feedback, and do not solicit votes or use unsolicited messages. These are audience hypotheses, not evidence of adoption or guaranteed growth.
