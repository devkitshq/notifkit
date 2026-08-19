# Multi-step Workflows Example

This example demonstrates how to define, sync, and trigger multi-step drip notification workflows using the `NotifkitClient` SDK.

## Workflow Structure

1. **Step 1**: Dispatches immediate welcome email (`onboarding-welcome`).
2. **Step 2**: Pauses execution using `wait` (`1h`).
3. **Step 3**: Dispatches follow-up email (`onboarding-followup`).

## How to Run

```bash
export NOTIFKIT_API_URL="http://localhost:4000"
export ADMIN_API_KEY="your_admin_api_key"

node index.js
```
