import assert from "node:assert/strict";
import test from "node:test";

test("Pi coworker kill switch prevents the orchestrator from registering tools or lifecycle hooks", async () => {
  const previous = process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED;
  process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED = "1";
  try {
    const registered: string[] = [];
    const pi: any = {
      on(name: string) { registered.push(`event:${name}`); },
      registerTool(tool: any) { registered.push(`tool:${tool.name}`); },
      registerCommand(name: string) { registered.push(`command:${name}`); },
    };
    const extensionUrl = new URL(`../src/index.ts?disabled=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    assert.deepEqual(registered, []);
  } finally {
    if (previous === undefined) delete process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED;
    else process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED = previous;
  }
});
