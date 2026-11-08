import { MOMOAI_ORIGIN } from '../core/momoai';

// The streaming API sends mono 24 kHz PCM16 frames even when wav is requested.
function wave(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function momoVoice(key: string, voice: string, text: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(`${MOMOAI_ORIGIN}/v1/chat/completions`, {
    method: 'POST', signal, redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'momo_359', stream: true, enable_thinking: false, modalities: ['text', 'audio'],
      audio: { voice, format: 'wav' },
      messages: [
        { role: 'system', content: '你是朗读器。逐字朗读用户给出的文字。保持原文，不解释，不改写，不加开头或结尾。' },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error(`MomoAI 语音合成失败（HTTP ${response.status}）`);

  let spoken = '';
  let audio = '';
  let done = false;
  for (const line of (await response.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { done = true; break; }
    if (!data) continue;
    const event = JSON.parse(data) as { error?: unknown; choices?: Array<{ delta?: { content?: string; audio?: { data?: string } } }> };
    if (event.error) throw new Error('MomoAI 语音合成失败，请检查模型额度。');
    const delta = event.choices?.[0]?.delta;
    spoken += delta?.content ?? '';
    audio += delta?.audio?.data ?? '';
  }
  if (!done || !audio || spoken.trim().normalize() !== text.trim().normalize()) throw new Error('MomoAI 未返回与原稿一致的完整语音。');
  const pcm = Buffer.from(audio, 'base64');
  if (!pcm.length || pcm.length % 2 !== 0) throw new Error('MomoAI 返回的语音格式无效。');
  return wave(pcm);
}
