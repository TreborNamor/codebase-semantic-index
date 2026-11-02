"""Export only our tool envelopes; never export opaque or reasoning payloads."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('session')
parser.add_argument('output', type=Path)
args = parser.parse_args()
if not all(c in '0123456789abcdef-' for c in args.session):
    raise ValueError('Invalid Copilot session identifier')
source = Path.home()/'.copilot'/'session-state'/args.session/'events.jsonl'
events = [json.loads(line) for line in source.read_text(encoding='utf-8').splitlines()]
starts = {e['data']['toolCallId']:e['data'] for e in events if e['type']=='tool.execution_start' and e['data'].get('toolName','').startswith('codeconverge-')}
if not starts:
    raise ValueError('No actual CodeConverge tool invocations in this session')
selected = []
for event in events:
    data = event.get('data',{})
    item = {'type':event['type'],'at':event.get('timestamp'),'agent_id':event.get('agentId')}
    if event['type']=='tool.execution_start' and data.get('toolCallId') in starts:
        item.update(tool=data['toolName'],arguments=data.get('arguments'),tool_call_id=data['toolCallId'],mcp_transport=data.get('mcpTransport'),mcp_source=data.get('mcpConfigSource'))
    elif event['type']=='tool.execution_complete' and data.get('toolCallId') in starts:
        content = data.get('result',{}).get('content','')
        if not isinstance(content,str) or len(content)>50000:
            raise ValueError('Unexpected tool result size or shape')
        item.update(tool=starts[data['toolCallId']]['toolName'],tool_call_id=data['toolCallId'],success=data.get('success'),result=json.loads(content))
    elif event['type'] in {'subagent.started','subagent.completed'}:
        item.update({k:data.get(k) for k in ['agentName','agentId','model','status'] if k in data})
    else:
        continue
    selected.append(item)
result={'actual_copilot_invocation':True,'copilot_session':args.session,'harness':'Copilot','events':selected}
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'output':str(args.output),'events':len(selected)}))
