// 与 AI 共用 MCP，不读取或打印连接凭据；JSONL 模式复用同一连接并串行执行。
const fs=require("node:fs/promises"),path=require("node:path"),readline=require("node:readline");
const {Client}=require("@modelcontextprotocol/sdk/client/index.js");
const {StdioClientTransport}=require("@modelcontextprotocol/sdk/client/stdio.js");
async function main(){
  const args=process.argv.slice(2);
  const take=name=>{const i=args.indexOf(name);if(i<0)return undefined;if(!args[i+1])throw Error("Missing "+name);const value=args[i+1];args.splice(i,2);return value;};
  const root=take("--data-dir")||process.env.DGN_GAME_DATA_DIR||path.join(process.env.LOCALAPPDATA,"DaGuoNeko_GameToolkit");
  const file=take("--args-file");
  if(args.length!==1 || (args[0]==="--jsonl"&&file))throw Error("Usage: node scripts/toolbox-call.cjs <tool|--list|--jsonl> [--data-dir path] [--args-file request.json]");
  const client=new Client({name:"daguoneko-cli",version:"1"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,"mcp/server.cjs"),"--data-dir",root],stderr:"pipe"}));
  const emit=value=>process.stdout.write(JSON.stringify(value)+"\n");
  const call=async request=>{
    if(!request||typeof request.name!=="string")throw Error("Expected {name, arguments}");
    const result=await client.callTool({name:request.name,arguments:request.arguments||{}},undefined,{timeout:110000});
    if(result.isError)process.exitCode=1;
    emit(result);
  };
  try {
    if(args[0]==="--list")emit(await client.listTools());
    else if(args[0]==="--jsonl") {
      for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
        if(!line.trim())continue;
        if(Buffer.byteLength(line)>1024*1024)throw Error("Request exceeds 1 MiB");
        await call(JSON.parse(line));
      }
    } else {
      let parameters={};
      if(file){if((await fs.stat(file)).size>1024*1024)throw Error("Request exceeds 1 MiB");parameters=JSON.parse(await fs.readFile(file,"utf8"));}
      await call({name:args[0],arguments:parameters});
    }
  } finally { await client.close(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
