import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {FrameDecoder, encodeFrame, MAX_FRAME} from '../rpc';

test('fragmented Unicode messages and adjacent frames preserve JSON boundaries', () => {
  const decoder = new FrameDecoder();
  const first = {id: 1, roots: ['C:\\Projects\\café']};
  const bytes = Buffer.concat([encodeFrame(first), encodeFrame({id: 2})]);
  const received: unknown[] = [];
  for (const value of bytes) received.push(...decoder.push(Buffer.from([value])));
  assert.deepEqual(received, [first, {id: 2}]);
});

test('unbounded frames are rejected before allocating their body', () => {
  const header = Buffer.alloc(4); header.writeUInt32LE(MAX_FRAME + 1);
  assert.throws(() => new FrameDecoder().push(header), /frame size/);
});
