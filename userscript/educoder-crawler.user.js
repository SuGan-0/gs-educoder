// ==UserScript==
// @name         头歌传统爬虫同步
// @namespace    local.educoder.crawler
// @version      1.1.0
// @description  把当前已登录浏览器的 cookie 发送给本地传统爬虫
// @match        https://www.educoder.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const API = 'http://127.0.0.1:43128/api/session';
  const DATA_API = 'http://127.0.0.1:43128/api/browser-response';

  function forwardResponse(detail) {
    const { url, payload } = detail;
    if (!url || payload === undefined || !/\/(homework_commons|shixun_exec|myshixuns\/[^/]+\/challenges|tasks\/[^/]+)\.json/.test(url)) return;
    GM_xmlhttpRequest({
      method: 'POST',
      url: DATA_API,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ url, payload, pageUrl: location.href }),
      onerror: () => {}
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.source === 'educoder-crawler-page') {
      forwardResponse(event.data);
    }
  });

  const bridge = document.createElement('script');
  bridge.textContent = `(() => {
    const match = (url) => /\\\\/(homework_commons|shixun_exec|myshixuns\\/[^/]+\\/challenges|tasks\\/[^/]+)\\\\.json/.test(String(url));
    const publish = (url, payload) => window.postMessage({ source: 'educoder-crawler-page', url: String(url), payload }, '*');
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (match(url)) response.clone().json().then((payload) => publish(url, payload)).catch(() => {});
      return response;
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__educoderCrawlerUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        const url = this.__educoderCrawlerUrl;
        if (match(url)) {
          try { publish(url, JSON.parse(this.responseText)); } catch (_) {}
        }
      });
      return originalSend.apply(this, args);
    };
  })();`;
  (document.head || document.documentElement).appendChild(bridge);
  bridge.remove();

  function addPanel() {
    if (document.querySelector('#educoder-crawler-panel')) return;
    const panel = document.createElement('aside');
    panel.id = 'educoder-crawler-panel';
    panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:99999;background:#fff;color:#222;padding:14px;width:300px;border:1px solid #bbb;border-radius:8px;font:14px sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.15)';
    panel.innerHTML = '<b>头歌传统爬虫</b><div style="margin:10px 0">先同步登录会话。刷新课堂实验页后，脚本会自动把实验接口响应转发到本地。</div><button id="educoder-crawler-sync">同步 Cookie</button>';
    document.body.appendChild(panel);
    panel.querySelector('#educoder-crawler-sync').addEventListener('click', () => {
      const send = (cookies) => GM_xmlhttpRequest({
        method: 'POST',
        url: API,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
          cookie: cookies,
          userAgent: navigator.userAgent,
          pageUrl: location.href,
          username: location.pathname.match(/^\/users\/([^/]+)/)?.[1] || '',
          courseId: location.pathname.match(/^\/classrooms\/([^/]+)/)?.[1] || ''
        }),
        onload: () => {
          panel.innerHTML = '<b>头歌传统爬虫</b><div style="margin:10px 0;color:#0d7a49">Cookie 已同步到本地服务。</div><div>现在在本机终端运行：<code>npm run crawler -- 1</code></div>';
        },
        onerror: () => {
          panel.innerHTML = '<b>头歌传统爬虫</b><div style="margin:10px 0;color:#b42318">本地服务未启动，请先在终端执行：<code>npm run crawler -- --server</code></div>';
        }
      });
      GM_cookie.list({ domain: '.educoder.net' }, (cookies, error) => {
        if (!error && cookies?.length) {
          send(cookies.map((item) => `${item.name}=${item.value}`).join('; '));
          return;
        }
        send(document.cookie);
      });
    });
  }

  setTimeout(addPanel, 1000);
})();
