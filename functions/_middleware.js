require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = 'https://api-inference.modelscope.cn/';
const API_KEY = process.env.MODELSCOPE_API_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 生成图片接口 - 使用 SSE 推送进度
app.post('/api/generate', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: '请输入提示词' });
  }

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    // 1. 提交异步任务
    sendEvent('status', { message: '正在提交生成任务...' });

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
      return res.end();
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
        return res.end();
      }

      const pollData = await pollRes.json();

      if (pollData.task_status === 'SUCCEED') {
        sendEvent('complete', {
          message: '生成完成！',
          imageUrl: pollData.output_images[0],
        });
        return res.end();
      }

      if (pollData.task_status === 'FAILED') {
        sendEvent('error', { message: '图片生成失败，请重试' });
        return res.end();
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.listen(PORT, () => {
  console.log(`🚀 文生图服务已启动: http://localhost:${PORT}`);
});
