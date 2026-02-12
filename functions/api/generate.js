// functions/api/generate.js

// 这个文件会自动处理 /api/generate 路径的请求

export async function onRequestPost(context) {
  // 1. 获取环境变量 (这里就是 Token 隐藏的地方)
  const { request, env } = context;
  const API_KEY = env.MODELSCOPE_API_KEY; // ⬅️ 从控制台注入
  const BASE_URL = 'https://api-inference.modelscope.cn/';

  // 2. 解析请求体
  const { prompt } = await request.json();

  if (!prompt || !prompt.trim()) {
    return new Response(JSON.stringify({ error: '请输入提示词' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 3. SSE 流式响应设置
  // 创建一个 TransformStream 来处理流
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // 发送 SSE 消息的辅助函数
  const sendEvent = async (type, data) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
  };

  // 4. 异步处理生成任务 (放在 setTimeout 中以避免 Pages 超时限制)
  (async () => {
    try {
      // --- 步骤 A: 提交任务 ---
      await sendEvent('status', { message: '正在提交生成任务...' });

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
        await sendEvent('error', { message: `API 请求失败: ${errText}` });
        await writer.close();
        return;
      }

      const submitData = await submitRes.json();
      const taskId = submitData.task_id;
      await sendEvent('status', { message: '任务已提交，正在生成中...' });

      // --- 步骤 B: 轮询结果 ---
      const MAX_POLLS = 40; // Cloudflare Worker 免费版有 1分钟 CPU 时间限制，建议轮询次数别太多
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, 3000)); // 等待 3秒

        const pollRes = await fetch(`${BASE_URL}v1/tasks/${taskId}`, {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'X-ModelScope-Task-Type': 'image_generation',
          },
        });

        const pollData = await pollRes.json();

        if (pollData.task_status === 'SUCCEED') {
          await sendEvent('complete', {
            message: '生成完成！',
            imageUrl: pollData.output_images[0].url // 注意：根据 ModelScope 实际返回结构调整
          });
          await writer.close();
          return;
        }

        if (pollData.task_status === 'FAILED') {
          await sendEvent('error', { message: '生成失败: ' + (pollData.error?.message || '未知原因') });
          await writer.close();
          return;
        }

        await sendEvent('status', { message: `生成中... (${i + 1})` });
      }

      await sendEvent('error', { message: '生成超时，请重试' });
      await writer.close();

    } catch (err) {
      await sendEvent('error', { message: `服务器错误: ${err.message}` });
      await writer.close();
    }
  })();

  // 5. 返回流式响应
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*', // 根据需要调整 CORS
    },
  });
}
