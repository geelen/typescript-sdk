import { Client } from '../src/client/index.ts';
// import { StdioClientTransport } from "../src/client/stdio.ts";
import { SSEClientTransport } from "../src/client/sse.ts";

// const transport = new StdioClientTransport({
//   command: "node_modules/.bin/tsx",
//   args: ["server.ts"]
// });

const transport = new SSEClientTransport({
  url:
})

const client = new Client(
  {
    name: "example-client",
    version: "1.0.0"
  },
  {
    capabilities: {
      // prompts: {},
      // resources: {},
      tools: {}
    }
  }
);

await client.connect(transport);

// List prompts
// const prompts = await client.listPrompts();
// console.log(prompts)
//
// // Get a prompt
// const prompt = await client.getPrompt("example-prompt", {
//   arg1: "value"
// });
//

// List resources
// const resources = await client.listResources();
// console.log(resources)
// // Read a resource
// const resource = await client.readResource("file:///example.txt");
//

// List tools
const tools = await client.listTools();
console.log(tools)

// // Call a tool
// const result = await client.callTool({
//   name: "example-tool",
//   arguments: {
//     arg1: "value"
//   })
