/*!
 * contact-channels.js · <contact-channels> 可复用「联系我们」渠道组件
 * ------------------------------------------------------------------
 * 零依赖 Web Component（Shadow DOM 样式隔离 + 内联 SVG 图标）。
 * 一个 script 标签引入后，可在任意页面 / React / Vue 中复用。
 *
 * 快速开始（默认即元冰可渠道配置）：
 *   1. 用 script 标签引入本文件
 *   2. 页面中放置 <contact-channels></contact-channels>
 *
 * 主题 / 品牌快捷属性：
 *   <contact-channels theme="light" accent="#7c5cff" brand-name="某产品" tagline="Build with&#10;某产品"></contact-channels>
 *
 * 自定义配置（二选一）：
 *   1) JS 属性：document.querySelector('contact-channels').config = { ... }
 *   2) HTML 内嵌：在 contact-channels 标签内放一个 type="application/json" 的 script 子元素
 *
 * 配置结构与主题变量详见同目录 README.md。
 * 默认二维码资源位于组件同目录 assets/，相对路径按「组件脚本所在目录」解析。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !('customElements' in window)) return;
  if (customElements.get('contact-channels')) return;

  var currentScript = document.currentScript;
  var SCRIPT_DIR = currentScript && currentScript.src
    ? currentScript.src.slice(0, currentScript.src.lastIndexOf('/') + 1)
    : '';

  /* 内置资源相对组件脚本目录解析；外部传入的 http(s)/data:/绝对路径原样使用 */
  function asset(p) {
    if (!p) return '';
    if (/^(https?:|data:|blob:)/i.test(p) || p.charAt(0) === '/') return p;
    return SCRIPT_DIR + p;
  }

  var ICONS = {
    email:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7.5 12 13.5l8.5-6"/></svg>',
    wechat:
      '<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="M9.4 3.2c-4.02 0-7.4 2.75-7.4 6.28 0 2.02 1.1 3.82 2.8 5l-.7 2.1 2.42-1.22c.55.15 1.13.25 1.73.28a5.6 5.6 0 0 1-.15-1.28c0-3.28 3.1-5.94 6.93-5.94.22 0 .45.01.67.03C15 5.9 12.5 3.2 9.4 3.2Zm-2.5 3.3a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9Zm5 0a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9Z"/><path d="M22 14.36c0-2.94-2.83-5.32-6.32-5.32s-6.32 2.38-6.32 5.32 2.83 5.32 6.32 5.32c.7 0 1.38-.1 2-.28l2.05 1.03-.6-1.8c1.86-1.03 2.87-2.54 2.87-4.27Zm-8.5-1.2a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Zm4.36 0a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z"/></svg>',
    telegram:
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.64 6.86-1.9 8.96c-.14.63-.52.78-1.05.49l-2.9-2.14-1.4 1.35c-.16.15-.29.28-.58.28l.2-2.95 5.37-4.85c.23-.2-.05-.32-.36-.11l-6.64 4.18-2.86-.9c-.62-.19-.63-.62.13-.92l11.2-4.32c.52-.19.97.12.8.93Z"/></svg>',
    github:
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
    phone:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h3l1.5 4L7.6 9.7a12 12 0 0 0 6.7 6.7l1.7-1.9 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 3 6.2 2 2 0 0 1 5 4Z"/></svg>',
    link:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 6.22"/><path d="M14 10a5 5 0 0 0-7.07 0L4.8 12.12a5 5 0 0 0 7.07 7.07l1.4-1.4"/></svg>'
  };

  var ICON_COPY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

  var LOGO_DEFAULT =
    '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="cc-logo-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#41a2ff"/><stop offset="1" stop-color="#155ce8"/></linearGradient></defs><path d="M24 2.5 42.5 13.25v21.5L24 45.5 5.5 34.75v-21.5Z" fill="url(#cc-logo-g)"/><text x="24" y="31.5" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="700" fill="#fff">Y</text></svg>';

  var DEFAULT_CONFIG = {
    brand: {
      logo: '',                    /* 留空使用内置六边形 Y 标志；可传图片地址 */
      name: '元冰可',
      tagline: 'Connect with\n元冰可'
    },
    channels: [
      { type: 'email',    label: '邮箱',            value: 'ybkk01@126.com' },
      { type: 'wechat',   label: '企业微信群',      value: 'https://work.weixin.qq.com/ca/cawcdecedba18d0ddb' },
      { type: 'telegram', label: 'Telegram 交流群', value: 'https://t.me/+YvW7087WEq9kMTg9' }
    ],
    cards: [
      { label: '元冰可公众号',     image: asset('assets/qrcode-official.jpg'), hint: '扫码关注' },
      { label: 'Telegram 交流群', image: asset('assets/qrcode-telegram.png'), hint: '扫码加群', href: 'https://t.me/+YvW7087WEq9kMTg9' }
    ]
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* 用户配置按节覆盖默认值：brand / channels / cards 均可整体替换或置空 */
  function mergeConfig(user) {
    var base = clone(DEFAULT_CONFIG);
    if (!user || typeof user !== 'object') return base;
    var out = {};
    out.brand = ('brand' in user) ? user.brand : base.brand;
    out.channels = Array.isArray(user.channels) ? user.channels : base.channels;
    out.cards = Array.isArray(user.cards) ? user.cards : base.cards;
    if (user.heading) out.heading = user.heading;
    return out;
  }

  var CSS = [
    ':host{',
    '  /* 主题变量：外部可通过这些变量覆盖 */',
    '  --cc-accent:#2f6bff;',
    '  --cc-bg:#161618;',
    '  --cc-fg:#f5f5f7;',
    '  --cc-muted:#8f8f94;',
    '  --cc-hover:rgba(255,255,255,.08);',
    '  --cc-radius:16px;',
    '  --cc-maxw:860px;',
    '  display:block;',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
    '  color:var(--cc-fg);',
    '  -webkit-font-smoothing:antialiased;',
    '}',
    ':host([theme="light"]){',
    '  --cc-bg:#f5f5f7;',
    '  --cc-fg:#1d1d1f;',
    '  --cc-muted:#7a7a80;',
    '  --cc-hover:rgba(0,0,0,.06);',
    '}',
    '.root{background:var(--cc-bg);border-radius:var(--cc-radius);padding:40px 24px 44px;display:flex;justify-content:center}',
    '@media (max-width:480px){.root{padding:28px 12px 32px}}',
    '.col{display:flex;flex-direction:column;align-items:flex-start;gap:30px;max-width:var(--cc-maxw);width:100%}',
    '.lockup{display:flex;align-items:center;gap:16px}',
    '.logo{width:46px;height:46px;flex:none}',
    '.logo svg,.logo img{width:100%;height:100%;display:block}',
    '.divider{width:1px;height:38px;background:currentColor;opacity:.22;flex:none}',
    '.tagline{font-size:21px;line-height:1.32;font-weight:600;letter-spacing:.2px}',
    '.tl{display:flex;align-items:center}',
    '.dot{width:9px;height:9px;border-radius:50%;background:var(--cc-accent);display:inline-block;margin-left:4px}',
    '.heading{margin:0;font-size:17px;font-weight:700}',
    '.channels{display:flex;flex-wrap:wrap;gap:8px}',
    '.chwrap{position:relative;display:inline-flex}',
    '.ch{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;color:var(--cc-muted);background:transparent;text-decoration:none;transition:background .18s,color .18s,transform .18s;cursor:pointer;border:0;padding:0}',
    '.ch svg{width:21px;height:21px;display:block}',
    '.ch:hover{color:var(--cc-fg);background:var(--cc-hover);transform:translateY(-1px)}',
    '.ch:focus-visible,.copy:focus-visible,.card:focus-visible{outline:2px solid var(--cc-accent);outline-offset:2px}',
    '.copy{position:absolute;right:-6px;top:-6px;width:22px;height:22px;border-radius:50%;border:0;background:var(--cc-accent);color:#fff;display:grid;place-items:center;cursor:pointer;opacity:0;transform:scale(.6);transition:opacity .18s,transform .18s;padding:0}',
    '.copy svg{width:12px;height:12px}',
    '.chwrap:hover .copy,.copy:focus-visible{opacity:1;transform:scale(1)}',
    '@media (hover:none){.copy{opacity:.9;transform:scale(1)}}',
    '.cards{display:flex;flex-wrap:wrap;gap:30px 34px}',
    '.card{margin:0;display:flex;flex-direction:column;align-items:center;gap:10px;cursor:zoom-in;width:150px;border:0;background:transparent;padding:0;color:inherit;font:inherit;transition:transform .18s}',
    '.card:hover{transform:translateY(-4px)}',
    '.qr{display:block;width:150px;aspect-ratio:1/1;background:#fff;border-radius:14px;padding:10px;box-sizing:border-box;box-shadow:0 1px 0 rgba(255,255,255,.06)}',
    ':host([theme="light"]) .qr{box-shadow:0 2px 14px rgba(0,0,0,.08)}',
    '.card:hover .qr{box-shadow:0 14px 34px rgba(0,0,0,.35)}',
    ':host([theme="light"]) .card:hover .qr{box-shadow:0 14px 30px rgba(0,0,0,.16)}',
    '.qr img{width:100%;height:100%;object-fit:contain;border-radius:6px;display:block}',
    '.qr.broken{display:grid;place-items:center;color:#b6b6bb;font-size:12px}',
    '.qr.broken::after{content:"二维码待配置"}',
    '.clabel{font-size:14px;text-align:center;line-height:1.4;opacity:.92}',
    '.toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:rgba(20,20,22,.92);color:#fff;font-size:13px;padding:9px 16px;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.3);z-index:2147483000;max-width:80vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.toast[hidden]{display:none}',
    ':host([theme="light"]) .toast{background:rgba(30,30,34,.95)}',
    '.lb{position:fixed;inset:0;background:rgba(8,8,10,.72);display:grid;place-items:center;z-index:2147483001;padding:24px}',
    '.lb[hidden]{display:none}',
    '.lb-panel{position:relative;background:#fff;color:#1d1d1f;border-radius:18px;padding:22px 22px 18px;display:flex;flex-direction:column;align-items:center;gap:10px;box-shadow:0 24px 80px rgba(0,0,0,.5);max-width:88vw}',
    '.lb-img{width:min(300px,64vw);aspect-ratio:1/1;object-fit:contain}',
    '.lb-label{font-size:16px;font-weight:700}',
    '.lb-hint{font-size:12px;color:#8a8a8e}',
    '.lb-open{font-size:13px;color:#2f6bff;text-decoration:none}',
    '.lb-open:hover{text-decoration:underline}',
    '.lb-close{position:absolute;top:10px;right:10px;width:28px;height:28px;border-radius:50%;border:0;background:rgba(0,0,0,.06);color:#333;cursor:pointer;font-size:13px;display:grid;place-items:center;padding:0}',
    '.lb-close:hover{background:rgba(0,0,0,.12)}',
    '@media (prefers-reduced-motion:reduce){.ch,.card,.copy{transition:none!important}}'
  ].join('\n');

  class ContactChannelsElement extends HTMLElement {
    static get observedAttributes() { return ['theme', 'accent', 'brand-name', 'tagline']; }
    static get defaultConfig() { return clone(DEFAULT_CONFIG); }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._config = null;
      this._jsonCfg = undefined;
      this._toastT = 0;
      this._onKey = (e) => { if (e.key === 'Escape') this._closeLightbox(); };
      if (Object.prototype.hasOwnProperty.call(this, 'config')) {
        const v = this.config;
        delete this.config;
        this.config = v;
      }
    }

    set config(v) {
      this._config = mergeConfig(v);
      if (this.isConnected) this.render();
    }
    get config() { return this._cfg(); }

    connectedCallback() {
      if (!this._config && this._jsonCfg === undefined) {
        const s = this.querySelector('script[type="application/json"]');
        if (s) {
          try { this._jsonCfg = JSON.parse(s.textContent); }
          catch (e) { console.warn('[contact-channels] 内嵌配置 JSON 解析失败：', e); }
        }
      }
      this.render();
    }

    disconnectedCallback() {
      document.removeEventListener('keydown', this._onKey);
    }

    attributeChangedCallback(name, oldV, newV) {
      if (oldV === newV) return;
      if (name === 'accent') {
        if (newV) this.style.setProperty('--cc-accent', newV);
        else this.style.removeProperty('--cc-accent');
        return;
      }
      if (this.isConnected) this.render();
    }

    _cfg() {
      let c = this._config
        ? clone(this._config)
        : (this._jsonCfg !== undefined ? mergeConfig(this._jsonCfg) : clone(DEFAULT_CONFIG));
      if (this.hasAttribute('brand-name') || this.hasAttribute('tagline')) {
        c.brand = c.brand ? clone(c.brand) : {};
        if (this.hasAttribute('brand-name')) c.brand.name = this.getAttribute('brand-name');
        if (this.hasAttribute('tagline')) c.brand.tagline = this.getAttribute('tagline');
      }
      return c;
    }

    render() {
      const c = this._cfg();
      const p = ['<div class="root" part="root"><div class="col">'];

      if (c.brand) {
        const lines = String(c.brand.tagline || '').split('\n').filter(Boolean);
        const tagHtml = lines.map((l, i) =>
          '<div class="tl">' + esc(l) + (i === lines.length - 1 ? '<span class="dot" aria-hidden="true"></span>' : '') + '</div>'
        ).join('');
        const logoHtml = c.brand.logo
          ? '<img class="logo" src="' + esc(c.brand.logo) + '" alt="' + esc(c.brand.name || 'logo') + '">'
          : '<span class="logo">' + LOGO_DEFAULT + '</span>';
        p.push('<div class="lockup" part="brand">' + logoHtml +
          '<span class="divider" aria-hidden="true"></span>' +
          '<div class="tagline">' + tagHtml + '</div></div>');
      }

      if (c.heading) p.push('<h3 class="heading" part="heading">' + esc(c.heading) + '</h3>');

      if (Array.isArray(c.channels) && c.channels.length) {
        p.push('<nav class="channels" part="channels" aria-label="联系方式">');
        c.channels.forEach((ch, i) => {
          const icon = ICONS[ch.type] || ICONS.link;
          const label = ch.label || '';
          const val = ch.value || '';
          const isMail = ch.type === 'email';
          const tip = label + (val ? '：' + val : '');
          if (!val) {
            p.push('<span class="chwrap"><span class="ch" title="' + esc(tip) + '">' + icon + '</span></span>');
            return;
          }
          const href = isMail ? 'mailto:' + esc(val) : esc(val);
          const blank = isMail ? '' : ' target="_blank" rel="noopener noreferrer"';
          p.push('<span class="chwrap">' +
            '<a class="ch" data-i="' + i + '" href="' + href + '"' + blank +
            ' aria-label="' + esc(label) + (isMail ? ' ' + esc(val) : '') + '" title="' + esc(tip) + '">' + icon + '</a>' +
            (isMail ? '<button class="copy" type="button" data-copy="' + esc(val) + '" aria-label="复制邮箱地址" title="复制">' + ICON_COPY + '</button>' : '') +
            '</span>');
        });
        p.push('</nav>');
      }

      if (Array.isArray(c.cards) && c.cards.length) {
        p.push('<div class="cards" part="cards">');
        c.cards.forEach((cd, i) => {
          p.push('<figure class="card" part="card" role="button" tabindex="0" data-i="' + i +
            '" aria-label="放大查看 ' + esc(cd.label || '二维码') + '">' +
            '<span class="qr"><img src="' + esc(cd.image || '') + '" alt="' + esc((cd.label || '') + ' 二维码') + '" loading="lazy" draggable="false"></span>' +
            '<figcaption class="clabel">' + esc(cd.label || '') + '</figcaption>' +
            '</figure>');
        });
        p.push('</div>');
      }

      p.push('</div></div>');
      p.push('<div class="toast" role="status" aria-live="polite" hidden></div>');
      p.push('<div class="lb" hidden role="dialog" aria-modal="true" aria-label="二维码放大查看">' +
        '<div class="lb-panel">' +
        '<button class="lb-close" type="button" aria-label="关闭">✕</button>' +
        '<img class="lb-img" alt="">' +
        '<div class="lb-label"></div>' +
        '<div class="lb-hint"></div>' +
        '<a class="lb-open" target="_blank" rel="noopener noreferrer" hidden>在浏览器中打开 ↗</a>' +
        '</div></div>');

      this.shadowRoot.innerHTML = '<style>' + CSS + '</style>' + p.join('');
      this._wire(c);
    }

    _wire(c) {
      const sr = this.shadowRoot;
      const self = this;

      sr.querySelectorAll('.copy').forEach((b) => {
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          self._copy(b.getAttribute('data-copy'));
          self.dispatchEvent(new CustomEvent('cc-copy', { detail: { text: b.getAttribute('data-copy') }, bubbles: true, composed: true }));
        });
      });

      sr.querySelectorAll('a.ch').forEach((a) => {
        a.addEventListener('click', () => {
          const ch = c.channels[+a.getAttribute('data-i')];
          self.dispatchEvent(new CustomEvent('cc-channel-click', { detail: { channel: ch }, bubbles: true, composed: true }));
        });
      });

      sr.querySelectorAll('.card').forEach((card) => {
        const open = () => {
          const cd = c.cards[+card.getAttribute('data-i')];
          self._openLightbox(cd);
          self.dispatchEvent(new CustomEvent('cc-card-click', { detail: { card: cd }, bubbles: true, composed: true }));
        };
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
      });

      sr.querySelectorAll('.qr img').forEach((img) => {
        img.addEventListener('error', () => {
          const q = img.closest('.qr');
          if (q) { q.classList.add('broken'); img.style.display = 'none'; }
        });
      });

      const lb = sr.querySelector('.lb');
      lb.addEventListener('click', (e) => { if (e.target === lb) self._closeLightbox(); });
      sr.querySelector('.lb-close').addEventListener('click', () => self._closeLightbox());

      document.removeEventListener('keydown', this._onKey);
      document.addEventListener('keydown', this._onKey);
    }

    _openLightbox(cd) {
      const sr = this.shadowRoot;
      const lb = sr.querySelector('.lb');
      if (!cd) return;
      sr.querySelector('.lb-img').src = cd.image || '';
      sr.querySelector('.lb-label').textContent = cd.label || '';
      sr.querySelector('.lb-hint').textContent = cd.hint || '扫码或长按识别';
      const open = sr.querySelector('.lb-open');
      if (cd.href) { open.href = cd.href; open.hidden = false; } else { open.hidden = true; }
      lb.hidden = false;
      sr.querySelector('.lb-close').focus();
    }

    _closeLightbox() {
      const lb = this.shadowRoot.querySelector('.lb');
      if (lb && !lb.hidden) lb.hidden = true;
    }

    _copy(text) {
      const self = this;
      const done = (ok) => self._toast(ok ? '已复制：' + text : '复制失败，请手动复制');
      const legacy = () => {
        try {
          const t = document.createElement('textarea');
          t.value = text;
          t.style.cssText = 'position:fixed;opacity:0';
          document.body.appendChild(t);
          t.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(t);
          done(ok);
        } catch (e) { done(false); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => done(true), legacy);
      } else legacy();
    }

    _toast(msg) {
      const t = this.shadowRoot.querySelector('.toast');
      if (!t) return;
      t.textContent = msg;
      t.hidden = false;
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => { t.hidden = true; }, 1800);
    }
  }

  customElements.define('contact-channels', ContactChannelsElement);
})();
