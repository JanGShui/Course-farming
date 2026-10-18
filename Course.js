// ⚠️ 安装前请把下方 @match 改成你的课程站点地址，例如：
//    @match https://course.example.com/*
//    请勿使用 *://*/* 之类的宽泛匹配，避免脚本在无关网站上运行。
// ==UserScript==
// @name         课程自动播放与目录巡检脚本
// @namespace    JanGShui.CourseFarming
// @version      1.1.1
// @description  基于 DOM 观察的课程目录巡检、自动播放与已学小节跳过（站点选择器需自行配置）
// @match        https://example.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @noframes
// @author       JanGShui
// @copyright    2026 JanGShui
// @license      Personal-NonCommercial-NoResale
// ==/UserScript==

(function () {
    'use strict';

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    // 使用页面自身的 document，避免在沙箱环境中操作到错误的文档对象
    const pageDoc = pageWindow.document || document;
    const APP_KEY = '__RED_AUTO_CORE__';

    // =========================================================================
    // 【L1 目标特征字典层】
    // =========================================================================
    const TARGET_PROFILE = {
        bootContainer: '.content_box___Ue-Ix',          // [1/5] 顶层目录容器
        unitItems: 'a.units_wrap_box___3DqST',          // [2/5] 视频小节链接集合
        activeClass: 'units_active_box___n73iR',        // [3/5] 当前播放节激活类名
        finishedSelector: '.study_success_svg___Dc7SQ', // [4/5] 100%完成绿勾标记
        clickSubTarget: '',                             // [5/5] 直接点击 <a> 自身

        videoSelector: 'video',                         // 匹配播放器底层 video 标签
        targetRate: 1.5,                                // 实际运行倍速（如服务端严查时间差可改为 1.0）
        spoofedRate: 1.0,                               // 欺骗前端检测返回的伪造倍速
        skipFinished: true,                             // 自动跳过已打绿勾的小节
        tickIntervalMs: 1000,                           // 每秒巡检一次
        stallThresholdMs: 7000,                         // 7秒无进度判定为卡死并重拉
    };

    // =========================================================================
    // 【L0 环境先发劫持层】
    // =========================================================================
    const EnvHijacker = {
        init() {
            // 必须修改页面所在 realm 的 Document 原型；修改沙箱里的 Document 不会影响页面检测。
            const PageDocument = pageWindow.Document || Document;
            try {
                Object.defineProperty(PageDocument.prototype, 'hidden', { get: () => false, configurable: true });
            } catch (e) {}
            try {
                Object.defineProperty(PageDocument.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
            } catch (e) {}
            try {
                PageDocument.prototype.hasFocus = () => true;
            } catch (e) {}

            const proto = pageWindow.HTMLMediaElement?.prototype;
            // 加锁避免脚本重复注入时把 playbackRate 的 setter 层层包裹。
            if (proto && !proto.__courseNativeSetRate) {
                const nativeRateDesc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
                if (nativeRateDesc && nativeRateDesc.set) {
                    proto.__courseNativeSetRate = nativeRateDesc.set;
                    Object.defineProperty(proto, 'playbackRate', {
                        configurable: true,
                        enumerable: true,
                        get() { return TARGET_PROFILE.spoofedRate; },
                        set() { proto.__courseNativeSetRate.call(this, TARGET_PROFILE.targetRate); }
                    });
                }
            }

            // 只拦截可见性与倍速事件。
            // 不要全局拦截 blur / mouseleave / mouseout：它们会破坏页面自身的菜单、输入框和悬浮交互。
            const blockedEvents = ['visibilitychange', 'webkitvisibilitychange', 'ratechange'];
            const interceptor = (e) => {
                e.stopImmediatePropagation();
            };
            blockedEvents.forEach(evt => {
                pageWindow.addEventListener(evt, interceptor, true);
                pageDoc.addEventListener(evt, interceptor, true);
            });
        }
    };

    // =========================================================================
    // 【L3 动态扩展插件层】
    // =========================================================================
    const PluginRegistry = [
        {
            name: 'DirectoryAutoOpenPlugin',
            // 预防某些情况下侧边栏目录未渲染：如果页面有“目录”按钮且容器不存在，可在此扩展点击展开
            onInit() {
                console.log('%c[Plugin] 自动化管线已挂载', 'color:#00E676');
            }
        }
    ];

    // =========================================================================
    // 【L2 核心驱动与看门狗引擎】
    // =========================================================================
    class AutomationCore {
        constructor() {
            this.videoEl = null;
            this.boundEndedHandler = null;
            this.timer = null;
            this.isSwitching = false;
            this.lastMediaTime = 0;
            this.lastWallTime = 0;
            this.lastResumeTime = 0;
            this.lastSwitchKey = '';
            this.switchAttempts = 0;
            this.pendingCompletionSince = 0;
        }

        async boot() {
            console.log('%c[Core] 正在等待课程目录容器渲染...', 'color:#00BCD4;font-weight:bold');
            await this.waitForElement(TARGET_PROFILE.bootContainer, 20000);
            console.log('%c[Core] 目录容器就绪，自动化引擎正式接管！', 'color:#4CAF50;font-size:14px;font-weight:bold');

            PluginRegistry.forEach(p => p.onInit && p.onInit(this));
            this.startWatchdog();
        }

        waitForElement(selector, timeoutMs = 15000) {
            return new Promise((resolve, reject) => {
                const el = pageDoc.querySelector(selector);
                if (el) return resolve(el);

                const obs = new MutationObserver(() => {
                    const found = pageDoc.querySelector(selector);
                    if (found) {
                        obs.disconnect();
                        clearTimeout(t);
                        resolve(found);
                    }
                });
                obs.observe(pageDoc.documentElement, { childList: true, subtree: true });

                const t = setTimeout(() => {
                    obs.disconnect();
                    reject(new Error(`等待目录容器超时: ${selector}（请确认侧边栏目录已加载）`));
                }, timeoutMs);
            });
        }

        queryDeep(selector, rootDoc = pageDoc, depth = 0) {
            if (depth > 3 || !rootDoc) return null;
            const direct = rootDoc.querySelector(selector);
            if (direct) return direct;

            const frames = rootDoc.querySelectorAll('iframe');
            for (const frame of Array.from(frames)) {
                try {
                    const subDoc = frame.contentDocument || frame.contentWindow?.document;
                    const found = this.queryDeep(selector, subDoc, depth + 1);
                    if (found) return found;
                } catch (e) {}
            }
            return null;
        }

        startWatchdog() {
            if (this.timer) clearInterval(this.timer);
            this.timer = setInterval(() => this.tick(), TARGET_PROFILE.tickIntervalMs);
        }

        tick() {
            if (this.isSwitching) return;

            const video = this.queryDeep(TARGET_PROFILE.videoSelector);
            for (const plugin of PluginRegistry) {
                if (typeof plugin.onTick === 'function') plugin.onTick(this, video);
            }

            if (!video) return;

            if (this.videoEl !== video) {
                this.bindVideoInstance(video);
            }

            // 如果当前小节在播放途中已经拿到绿勾（100%完成），直接切下一节
            const activeUnit = pageDoc.querySelector(`${TARGET_PROFILE.unitItems}.${TARGET_PROFILE.activeClass}`);
            if (activeUnit && TARGET_PROFILE.finishedSelector && activeUnit.querySelector(TARGET_PROFILE.finishedSelector)) {
                console.log('%c[Watchdog] 检测到当前小节已获得绿勾(100%)，立即切换下一节！', 'color:#4CAF50;font-weight:bold');
                this.advanceToNextUnit();
                return;
            }

            if (video.paused && !video.ended) {
                // 暂停期间不累计卡死计时，避免长时间暂停后恢复播放时被误判为卡死
                this.lastWallTime = 0;
                this.lastMediaTime = Number(video.currentTime || 0);
                this.resumeVideo(video, 'paused');
                return;
            }

            if (!video.paused && !video.ended) {
                const now = Date.now();
                const currTime = Number(video.currentTime || 0);

                if (this.lastWallTime === 0) {
                    this.lastWallTime = now;
                    this.lastMediaTime = currTime;
                } else {
                    const isStalled = Math.abs(currTime - this.lastMediaTime) < 0.01;
                    if (isStalled && (now - this.lastWallTime >= TARGET_PROFILE.stallThresholdMs)) {
                        this.resumeVideo(video, 'stalled');
                        this.lastWallTime = now;
                    } else if (!isStalled) {
                        this.lastWallTime = now;
                        this.lastMediaTime = currTime;
                    }
                }
            }

            if (video.ended) {
                this.advanceToNextUnit();
            }
        }

        bindVideoInstance(video) {
            if (this.videoEl && this.boundEndedHandler) {
                this.videoEl.removeEventListener('ended', this.boundEndedHandler);
            }
            this.videoEl = video;
            this.lastWallTime = Date.now();
            this.lastMediaTime = Number(video.currentTime || 0);

            if (video.__courseNativeSetRate) {
                video.__courseNativeSetRate.call(video, TARGET_PROFILE.targetRate);
            } else {
                video.playbackRate = TARGET_PROFILE.targetRate;
            }

            console.log(`%c[Core] 已接管视频元素，底层实际倍速已设为: ${TARGET_PROFILE.targetRate}x`, 'color:#2196F3;font-weight:bold');
            this.boundEndedHandler = () => this.advanceToNextUnit();
            video.addEventListener('ended', this.boundEndedHandler);
            this.resumeVideo(video, 'init-bind');
        }

        resumeVideo(video, reason) {
            const now = Date.now();
            if (now - this.lastResumeTime < 1500) return;
            this.lastResumeTime = now;

            console.log(`%c[Watchdog] 自动拉起视频播放 (原因: ${reason})`, 'color:#FF9800');
            const playPromise = video.play();
            if (playPromise && typeof playPromise.catch === 'function') {
                playPromise.catch(() => {
                    video.muted = true;
                    const mutedPlay = video.play();
                    if (mutedPlay && typeof mutedPlay.catch === 'function') {
                        mutedPlay.catch(err => console.error('[Watchdog] 静音播放失败:', err));
                    }
                });
            }
        }

        advanceToNextUnit() {
            if (this.isSwitching) return;
            this.isSwitching = true;

            const units = Array.from(pageDoc.querySelectorAll(TARGET_PROFILE.unitItems));
            if (units.length === 0) {
                console.warn('[Router] 未找到课程小节，可能目录尚未渲染或选择器已失效，跳过本次切换');
                this.isSwitching = false;
                return;
            }

            const activeIdx = units.findIndex(el => el.classList.contains(TARGET_PROFILE.activeClass));
            if (activeIdx < 0) {
                console.warn('[Router] 未找到当前激活小节，将从第一个未完成小节开始尝试');
            }
            const isDone = (el) => Boolean(TARGET_PROFILE.finishedSelector && el.querySelector(TARGET_PROFILE.finishedSelector));

            let nextTarget = null;
            // 从当前小节往后找第一个没打绿勾的小节；若前面的课有漏看的，也可以从头扫描
            for (let i = activeIdx + 1; i < units.length; i++) {
                if (TARGET_PROFILE.skipFinished && isDone(units[i])) continue;
                nextTarget = units[i];
                break;
            }

            // 如果当前位置往后全看完了，再从第 0 节扫描一遍有没有未完成的（比如前面只学了 57.56% 的小节）
            if (!nextTarget) {
                for (let i = 0; i < activeIdx; i++) {
                    if (TARGET_PROFILE.skipFinished && isDone(units[i])) continue;
                    nextTarget = units[i];
                    break;
                }
            }

            if (nextTarget) {
                this.pendingCompletionSince = 0;
            }

            if (!nextTarget) {
                // 当前小节可能刚播放完，平台还需要几秒才写入完成标记；
                // 先等待，避免把“尚未上报完成”误判成“全部课程已完成”。
                const activeUnit = activeIdx >= 0 ? units[activeIdx] : null;
                if (activeUnit && !isDone(activeUnit)) {
                    if (!this.pendingCompletionSince) {
                        this.pendingCompletionSince = Date.now();
                        console.log('%c[Router] 当前小节尚未出现完成标记，等待平台上报...', 'color:#FF9800');
                    }
                    if (Date.now() - this.pendingCompletionSince < 15000) {
                        this.isSwitching = false;
                        return;
                    }
                    console.warn('[Router] 当前小节仍未出现完成标记，已暂停自动切换。请手动确认该小节是否完成。');
                    clearInterval(this.timer);
                    this.timer = null;
                    this.isSwitching = false;
                    return;
                }

                console.log(`%c🎉 恭喜！全课程 ${units.length} 个小节已全部刷完（全部获得绿勾）！`, 'color:#4CAF50;font-size:16px;font-weight:bold');
                clearInterval(this.timer);
                this.timer = null;
                this.isSwitching = false;
                return;
            }

            // 防止点击未生效时，每隔 3.5 秒无限重复点击同一个小节
            const targetKey = `${nextTarget.getAttribute('href') || ''}|${(nextTarget.innerText || '').trim()}`;
            if (targetKey === this.lastSwitchKey) {
                this.switchAttempts += 1;
            } else {
                this.lastSwitchKey = targetKey;
                this.switchAttempts = 1;
            }
            if (this.switchAttempts > 8) {
                console.warn('[Router] 连续多次未能切换小节，已暂停自动切换。请检查目录选择器、点击方式或网络状态。');
                clearInterval(this.timer);
                this.timer = null;
                this.isSwitching = false;
                return;
            }

            const clickNode = TARGET_PROFILE.clickSubTarget
                ? nextTarget.querySelector(TARGET_PROFILE.clickSubTarget)
                : nextTarget;

            console.log('%c[Router] 正在切换至下一未完成小节:', 'color:#2196F3;font-weight:bold', (clickNode?.innerText || '').replace(/\s+/g, ' '));
            this.triggerClick(clickNode);

            setTimeout(() => {
                if (this.videoEl && this.boundEndedHandler) {
                    this.videoEl.removeEventListener('ended', this.boundEndedHandler);
                }
                this.videoEl = null;
                this.boundEndedHandler = null;
                this.isSwitching = false;
            }, 3500);
        }

        triggerClick(el) {
            if (!el) return;
            // 针对 <a href="..."> 节点直接调用原生 click()，同时兼容 React Router 与原生跳转
            if (typeof el.click === 'function') {
                el.click();
            } else {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: pageWindow }));
            }
        }

        destroy() {
            if (this.timer) clearInterval(this.timer);
            this.timer = null;
            if (this.videoEl && this.boundEndedHandler) {
                this.videoEl.removeEventListener('ended', this.boundEndedHandler);
            }
            this.videoEl = null;
            this.boundEndedHandler = null;
        }
    }

    EnvHijacker.init();

    const startApp = () => {
        if (pageWindow[APP_KEY]) pageWindow[APP_KEY].destroy();
        const app = new AutomationCore();
        pageWindow[APP_KEY] = app;
        app.boot().catch(err => console.error('[Core] 启动异常:', err));
    };

    if (pageDoc.readyState === 'loading') {
        pageDoc.addEventListener('DOMContentLoaded', startApp);
    } else {
        startApp();
    }
})();