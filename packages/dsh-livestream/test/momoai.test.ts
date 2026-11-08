import { afterEach, describe, expect, it, vi } from 'vitest';
import { momoVoice } from '../src/body/momoVoice';
import { createMomoAi } from '../src/dsh/momoai';
import { MOMOAI_KEY_REF, MOMOAI_ORIGIN } from '../src/core/momoai';

function setup() {
  const credentials = new Map<string, string>();
  const vault = {
    async resolve(ref: string) {
      const value = credentials.get(ref);
      return value ? { value } : undefined;
    },
    async set(ref: string, value: string) { credentials.set(ref, value); },
    async unset(ref: string) { credentials.delete(ref); },
  };
  const installModel = vi.fn(async () => {});
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  return { client: createMomoAi(() => vault, installModel), vault, installModel, fetcher };
}

afterEach(() => vi.unstubAllGlobals());

describe('MomoAI connection and recharge', () => {
  it('obtains a key for an account that has none and only returns public account fields', async () => {
    const { client, vault, installModel, fetcher } = setup();
    fetcher.mockResolvedValueOnce(Response.json({ success: true, authToken: 'test-session', user: { username: 'viewer' } }));
    fetcher.mockResolvedValueOnce(Response.json({ success: true, data: { user_momoai_key: 'test-model-key' } }));

    expect(await client.login('viewer@example.com', 'test-password')).toEqual({
      linked: true, account: { name: 'viewer', purchased: 0, gifted: 0, autoPurchaseDisabled: false },
    });
    expect(installModel).toHaveBeenCalledOnce();
    expect(await vault.resolve(MOMOAI_KEY_REF)).toEqual({ value: 'test-model-key' });
    expect(fetcher).toHaveBeenNthCalledWith(2, `${MOMOAI_ORIGIN}/api/user/momoai-key`, expect.objectContaining({
      body: JSON.stringify({ action: 'create' }), headers: expect.objectContaining({ authorization: 'Bearer test-session' }),
    }));
  });

  it('refuses to create a payment when the authorized account no longer matches the model key', async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(Response.json({ success: true, authToken: 'test-session', user: { user_momoai_key: 'old-key' } }));
    fetcher.mockResolvedValueOnce(Response.json({ success: true, user: { user_momoai_key: 'rotated-key' } }));

    await client.login('viewer@example.com', 'test-password');
    await expect(client.recharge(1)).rejects.toThrow('请重新登录 MomoAI');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('wraps complete PCM in a playable WAV and rejects audio for rewritten text', async () => {
    const { fetcher } = setup();
    const stream = () => new Response(
      'data: {"choices":[{"delta":{"content":"开播了","audio":{"data":"AAABAA=="}}}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
    fetcher.mockImplementation(async () => stream());

    const signal = new AbortController().signal;
    const wav = Buffer.from(await momoVoice('test-model-key', 'Cherry', '开播了', signal));
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.subarray(44)).toEqual(Buffer.from([0, 0, 1, 0]));
    await expect(momoVoice('test-model-key', 'Cherry', '下播了', signal)).rejects.toThrow('与原稿一致');
  });
});
