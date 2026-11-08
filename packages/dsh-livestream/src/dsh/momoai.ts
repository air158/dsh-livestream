import { MOMOAI_KEY_REF, MOMOAI_ORIGIN, type MomoStatus } from '../core/momoai';

const SESSION_REF = 'DSH_LIVESTREAM_MOMOAI_SESSION';

interface Vault {
  resolve(ref: string): Promise<{ value: string } | undefined>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

interface PlatformUser {
  username?: string;
  user_momoai_key?: string;
  credit_purchase?: string | number;
  credit_gift?: string | number;
  auto_purchase_tokens?: boolean | number;
}

interface PlatformResponse {
  success?: boolean;
  authToken?: string;
  code?: string;
  user?: PlatformUser;
  data?: { user_momoai_key?: string };
  qrCodeUrl?: string;
  orderNo?: string;
}

class MomoError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

async function request(path: string, token?: string, body?: Record<string, unknown>): Promise<PlatformResponse> {
  try {
    const res = await fetch(`${MOMOAI_ORIGIN}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await res.json() as PlatformResponse;
    if (!res.ok || payload.success !== true) throw new MomoError(res.ok ? 502 : res.status, 'MomoAI 暂时无法完成请求，请稍后重试。', payload.code);
    return payload;
  } catch (err) {
    if (err instanceof MomoError) throw err;
    throw new MomoError(502, '暂时连不上 MomoAI，请稍后重试。');
  }
}

function balance(user: PlatformUser): NonNullable<MomoStatus['account']> {
  return {
    name: user.username || 'MomoAI',
    purchased: Number(user.credit_purchase) || 0,
    gifted: Number(user.credit_gift) || 0,
    autoPurchaseDisabled: user.auto_purchase_tokens === false || user.auto_purchase_tokens === 0,
  };
}

export function createMomoAi(vault: () => Vault, installModel: () => Promise<void>) {
  let signingIn = false;

  async function readAccount() {
    const store = vault();
    const [key, session] = await Promise.all([store.resolve(MOMOAI_KEY_REF), store.resolve(SESSION_REF)]);
    if (!key?.value || !session?.value) return { linked: !!key?.value, account: null };
    const token = session.value;
    try {
      const { user } = await request('/api/auth/me', token);
      if (user?.user_momoai_key === key.value) return { linked: true, account: balance(user), token };
      return { linked: false, account: null, accountError: 'MomoAI 授权已更新，请重新登录。' };
    } catch (err) {
      if (err instanceof MomoError && (err.status === 401 || err.status === 403)) return { linked: true, account: null };
      throw err;
    }
  }

  return {
    async status(): Promise<MomoStatus> {
      try {
        const { linked, account, accountError } = await readAccount();
        return { linked, account, ...(accountError && { accountError }) };
      } catch (err) {
        if (!(err instanceof MomoError)) throw err;
        return { linked: true, account: null, accountError: err.message };
      }
    },
    async login(email: unknown, password: unknown): Promise<MomoStatus> {
      if (typeof email !== 'string' || !email.trim() || email.length > 320 || typeof password !== 'string' || !password || password.length > 1024) {
        throw new Error('请填写 MomoAI 邮箱和密码。');
      }
      if (signingIn) throw new Error('正在登录 MomoAI，请稍候。');
      const store = vault();
      signingIn = true;
      try {
        const { user, authToken } = await request('/api/auth/login', undefined, { email: email.trim(), password });
        if (!user || !authToken) throw new Error('MomoAI 未返回账号授权，请重新登录。');
        const key = user.user_momoai_key || (await request('/api/user/momoai-key', authToken, { action: 'create' })).data?.user_momoai_key;
        if (!key) throw new Error('MomoAI 未能为该账号开通模型调用。');
        await installModel();
        const previous = await store.resolve(SESSION_REF);
        await store.set(SESSION_REF, authToken);
        try {
          await store.set(MOMOAI_KEY_REF, key);
        } catch {
          if (previous?.value) await store.set(SESSION_REF, previous.value);
          else await store.unset(SESSION_REF);
          throw new Error('DSH 未能保存 MomoAI 授权，请重新登录。');
        }
        return { linked: true, account: balance(user) };
      } catch (err) {
        if (err instanceof MomoError && err.code === 'EMAIL_NOT_VERIFIED') throw new Error('请先验证 MomoAI 邮箱，再回来登录。');
        if (err instanceof MomoError && (err.status === 400 || err.status === 401 || err.status === 403)) throw new Error('MomoAI 登录失败，请检查邮箱、密码和邮箱验证状态。');
        throw err;
      } finally {
        signingIn = false;
      }
    },
    async recharge(amount: unknown): Promise<{ qr: string; orderNo: string }> {
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > 10_000) throw new Error('请输入 1 至 10000 元的整数金额。');
      const { token } = await readAccount();
      if (!token) throw new Error('请重新登录 MomoAI，再发起充值。');
      const { qrCodeUrl, orderNo } = await request('/api/payment/wechat', token, { amount, description: 'MomoAI 充值' });
      if (!qrCodeUrl?.startsWith('weixin://wxpay/') || typeof orderNo !== 'string' || !orderNo) throw new Error('MomoAI 未返回有效的微信付款码。');
      return { qr: qrCodeUrl, orderNo };
    },
  };
}
