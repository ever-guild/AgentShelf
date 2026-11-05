# PayPal agent setup

This guide installs nine project-level agent skills for PayPal integration work, they provide implementation guidance only and do not add dependencies or configure an editor

## Install the pinned skills

Run from the target project root, the commands check out immutable source commits and copy only the named skill directories into `.agents/skills`

They stop if any target skill directory already exists, preserving installed project skills

```sh
(
set -eu
mkdir -p .agents/skills
for skill in \
  paypal-best-practices \
  typescript-authentication \
  typescript-calling-endpoints \
  typescript-client-initialization \
  typescript-configuration-resilience \
  typescript-error-handling \
  typescript-getting-started \
  typescript-models \
  typescript-testing
do
  { test ! -e ".agents/skills/$skill" && test ! -L ".agents/skills/$skill"; } || { printf 'Already exists: %s\n' "$skill" >&2; exit 1; }
done

paypal_skill_tmp=$(mktemp -d)
trap 'rm -rf "$paypal_skill_tmp"' EXIT
git clone --filter=blob:none https://github.com/paypal/AI-Toolkit.git "$paypal_skill_tmp/paypal-ai-toolkit"
git -C "$paypal_skill_tmp/paypal-ai-toolkit" checkout --detach 89ac03f4f7fe27a45163ebeae44a61899735cdd4
cp -a "$paypal_skill_tmp/paypal-ai-toolkit/skills/paypal-best-practices" .agents/skills/

git clone --filter=blob:none https://github.com/paypaldev/server-sdk-context-plugin-preview.git "$paypal_skill_tmp/apimatic-preview"
git -C "$paypal_skill_tmp/apimatic-preview" checkout --detach 6aa057126f0d4709a42e15002aab832a94935d92
for skill in \
  typescript-authentication \
  typescript-calling-endpoints \
  typescript-client-initialization \
  typescript-configuration-resilience \
  typescript-error-handling \
  typescript-getting-started \
  typescript-models \
  typescript-testing
do
  cp -a "$paypal_skill_tmp/apimatic-preview/skills/typescript/$skill" .agents/skills/
done
)
```

The commands use only these source directories and immutable commits

- `paypal-best-practices` from [paypal/AI-Toolkit at `89ac03f4f7fe27a45163ebeae44a61899735cdd4`](https://github.com/paypal/AI-Toolkit/tree/89ac03f4f7fe27a45163ebeae44a61899735cdd4/skills/paypal-best-practices)
- `typescript-authentication` from [APIMatic preview at `6aa057126f0d4709a42e15002aab832a94935d92`](https://github.com/paypaldev/server-sdk-context-plugin-preview/tree/6aa057126f0d4709a42e15002aab832a94935d92/skills/typescript/typescript-authentication)
- `typescript-calling-endpoints` from [APIMatic preview at `6aa057126f0d4709a42e15002aab832a94935d92`](https://github.com/paypaldev/server-sdk-context-plugin-preview/tree/6aa057126f0d4709a42e15002aab832a94935d92/skills/typescript/typescript-calling-endpoints)
- `typescript-client-initialization` from [APIMatic preview at `6aa057126f0d4709a42e15002aab832a94935d92`](https://github.com/paypaldev/server-sdk-context-plugin-preview/tree/6aa057126f0d4709a42e15002aab832a94935d92/skills/typescript/typescript-client-initialization)
- `typescript-configuration-resilience` from [APIMatic preview at `6aa057126f0d4709a42e15002aab832a94935d92`](https://github.com/paypaldev/server-sdk-context-plugin-preview/tree/6aa057126f0d4709a42e15002aab832a94935d92/skills/typescript/typescript-configuration-resilience)
- `typescript-error-handling` from [APIMatic preview at `6aa057126f0d4709a42e15002aab832a94935d92`](https://github.com/paypaldev/server-sdk-context-plugin-preview/tree/6aa057126f0d4709a42e15002aab832a94935d92/skills/typescript/typescript-error-handling)
- `typescript-getting-started` from [APIMatic preview at `6aa057126f0d4709a42e15002aab832a94935d92`](https://github.com/paypaldev/server-sdk-context-plugin-preview/tree/6aa057126f0d4709a42e15002aab832a94935d92/skills/typescript/typescript-getting-started)
- `typescript-models` from [APIMatic preview at `6aa057126f0d4709a42e15002aab832a94935d92`](https://github.com/paypaldev/server-sdk-context-plugin-preview/tree/6aa057126f0d4709a42e15002aab832a94935d92/skills/typescript/typescript-models)
- `typescript-testing` from [APIMatic preview at `6aa057126f0d4709a42e15002aab832a94935d92`](https://github.com/paypaldev/server-sdk-context-plugin-preview/tree/6aa057126f0d4709a42e15002aab832a94935d92/skills/typescript/typescript-testing)

The APIMatic repository describes its content as an experimental hackathon preview, inspect its source again before relying on it after an SDK or API change

After installation, skills in `.agents/skills` are available from the project root in the next Codex turn, or can be loaded manually from that directory in the current turn

## Which skill applies

| Skill | Use it for |
| --- | --- |
| `paypal-best-practices` | PayPal integration design and safe payment flows, including Orders and webhooks |
| `typescript-getting-started` | Entry point and source-first workflow for the PayPal Server SDK |
| `typescript-client-initialization` | Server SDK client setup |
| `typescript-authentication` | Server SDK authentication configuration |
| `typescript-calling-endpoints` | Server SDK endpoint calls and request/response signatures |
| `typescript-models` | Server SDK request and response model shapes |
| `typescript-error-handling` | Server SDK errors and error translation |
| `typescript-configuration-resilience` | Server SDK retries, timeouts, cancellation, and transport configuration |
| `typescript-testing` | Tests around Server SDK calls |

## SDK boundaries and payment safety

The APIMatic skills cover `@paypal/paypal-server-sdk` 2.5.0, they are not references for `@paypal/agent-toolkit` or PayPal JavaScript SDK v6

Before implementing an endpoint, inspect the exact SDK version and its generated source, then use only guidance that matches the installed package

Keep payment work in PayPal Sandbox, a person must approve payment in PayPal before a server or authorized agent captures the approved order

Do not put credentials in source files, fixtures, screenshots, or skill instructions

Installing these skills does not prove an integration or establish eligibility for a partner claim, record actual use only after a project change has been implemented and reviewed
