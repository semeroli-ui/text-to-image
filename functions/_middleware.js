// server.js - 适配 Cloudflare Pages 版本

// 注意：不需要 dotenv，Cloudflare 会自动处理
// require('dotenv').config(); 

const express = require('express');
const { json, urlencoded } = express;

const app = express();

// Cloudflare Pages Functions 入口
// 这是一个中间件，用于将 Cloudflare 的环境变量注入到 Express 的请求中
module.exports = async function (request, env, ctx) {
  // 1. 将 Cloudflare 的环境变量挂载到 process.env (临时方案) 或直接传递
  // 这里我们创建一个新的 Express app 实例来处理每个请求，或者修改全局变量
  // 更优雅的方式是将 env 传递给路由，但为了最小化修改代码，我们临时挂载
  process.env.MODELSCOPE_API_KEY = env.MODELSCOPE_API_KEY;
  // 注意：BASE_URL 也可以通过环境变量设置，或者保持硬编码
  const BASE_URL = 'https://api-inference.modelscope.cn/';

  // 2. 重新定义路由（因为每次请求都会调用此函数，我们需要确保路由是基于当前 env 的）
  // 我们需要把原来的 app 逻辑封装在一个函数里
  const handler = getRouteHandler(BASE_URL);
  return handler(request, env, ctx);
};

// 将原来的路由逻辑提取为一个函数，接收 BASE_URL 作为参数
function getRouteHandler(BASE_URL) {
  const router = express.Router();

  router.use(json());
  router.use(urlencoded({ extended: true }));

  // 生成图片接口 - 使用 SSE 推送进度
  router.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: '请输入提示词' });
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (type, data) => {
      // 在 Serverless 环境中，res.write 可能不可用，我们使用 res.write if exists, else try to buffer
      // 但是 Cloudflare Pages Functions 支持流式响应，可以直接用
      if (res.write) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    };

    try {
      // 1. 提交异步任务
      sendEvent('status', { message: '正在提交生成任务...' });

      // 注意：这里使用 process.env，因为在 module.exports 里我们已经赋值了
      // 或者你可以直接使用传进来的逻辑，但为了复用原代码，我们用 process.env
      const API_KEY = process.env.MODELSCOPE_API_KEY; 

      const submitRes = await fetch(`${BASE_URL}v1/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'X-ModelScope-Async-Mode': 'true',
        },
        body: JSON.stringify({
          model: 'Tongyi-MAI/Z-Image-Turbo',
          prompt: prompt.trim(),
        }),
      });

      if (!submitRes.ok) {
        const errText = await submitRes.text();
        sendEvent('error', { message: `API 请求失败: ${submitRes.status} ${errText}` });
        res.end();
        return;
      }

      const submitData = await submitRes.json();
      const taskId = submitData.task_id;
      sendEvent('status', { message: '任务已提交，正在生成中...' });

      // 2. 轮询任务状态
      const MAX_POLLS = 60; // 最多轮询 60 次（5分钟）
      for (let i = 0; i < MAX_POLLS; i++) {
        await sleep(3000);

        const pollRes = await fetch(`${BASE_URL}v1/tasks/${taskId}`, {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'X-ModelScope-Task-Type': 'image_generation',
          },
        });

        if (!pollRes.ok) {
          sendEvent('error', { message: `轮询失败: ${pollRes.status}` });
          res.end();
          return;
        }

        const pollData = await pollRes.json();

        if (pollData.task_status === 'SUCCEED') {
          sendEvent('complete', {
            message: '生成完成！',
            imageUrl: pollData.output_images.url, // 注意：ModelScope 返回结构可能包含 url 字段
          });
          res.end();
          return;
        }

        if (pollData.task_status === 'FAILED') {
          sendEvent('error', { message: `图片生成失败: ${pollData.error?.message || '未知错误'}` });
          res.end();
          return;
        }

        // 仍在处理中
        sendEvent('status', { message: `正在生成中... (${i + 1})` });
      }

      sendEvent('error', { message: '生成超时，请重试' });
      res.end();
    } catch (err) {
      console.error('Generate error:', err);
      sendEvent('error', { message: `服务器错误: ${err.message}` });
      res.end();
    }
  });

  // 包装 Express Router 为 Cloudflare Pages Function 兼容格式
  return async (request, env, ctx) => {
    // 创建一个 Promise 来捕获 Express 的响应
    return new Promise((resolve) => {
      // 模拟 Node.js 的 req/res
      const fakeReq = new Proxy(request, {
        get(target, prop) {
          return target[prop] || undefined;
        },
      });

      // 这是一个简化的适配器
      const fakeRes = {
        statusCode: 200,
        headers: new Headers(),
        body: null,
        write: (chunk) => {
          // 对于流式响应，我们需要使用 TransformStream
          if (!fakeRes._stream) {
            fakeRes._stream = new TransformStream();
            resolve(new Response(fakeRes._stream.readable, { 
              status: fakeRes.statusCode, 
              headers: fakeRes.headers 
            }));
            fakeRes._writer = fakeRes._stream.writable.getWriter();
          }
          fakeRes._writer.write(chunk);
        },
        end: (chunk) => {
          if (chunk) fakeRes.write(chunk);
          if (fakeRes._writer) {
            fakeRes._writer.close();
          } else {
            resolve(new Response(fakeRes.body || '', { 
              status: fakeRes.statusCode, 
              headers: fakeRes.headers 
            }));
          }
        },
        set: (name, value) => {
          fakeRes.headers.set(name, value);
          return fakeRes;
        },
        status: (code) => {
          fakeRes.statusCode = code;
          return fakeRes;
        },
      };

      // 调用 Express 路由
      router(fakeReq, fakeRes, () => {
        // 404
        fakeRes.status(404).end('Not Found');
      });
    });
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
