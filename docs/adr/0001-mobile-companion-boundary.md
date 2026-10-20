---
status: accepted
---

# Use a mobile companion with a restricted gateway

The six interview answers support a separate Safari companion on the user's Mac, reusing Whiteboard's HTTP API through a restricted local gateway and private Tailscale Serve HTTPS access. A plugin cannot supply the standalone phone interface; adapting the whole Code OSS desktop would couple mobile work to its release and security maintenance. Whiteboard remains the source of review data and history; the gateway holds its token and permits only the selected content operations, excluding agent and desktop control.

The user confirmed the combined [design summary](../mobile-whiteboard-plan.md) on October 19, 2026; the GitHub repository already contains upstream Whiteboard code for inspection and potential reuse, which does not commit the product to a desktop fork.
