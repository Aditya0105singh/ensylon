#!/bin/sh

# NOTE: upstream KeepHQ dumped the full environment here (`env`) for debugging.
# That prints every build-time variable into the deploy log, including tokens
# the host does not redact, so it is deliberately not done.

# 4096 MB is enough after removing Sentry (productionBrowserSourceMaps was the
# actual driver of the prior OOM at 4096, not general tree size) and the
# CopilotKit/Monaco weight that had no working backend behind it anyway.
NODE_OPTIONS="--max-old-space-size=4096" next build
