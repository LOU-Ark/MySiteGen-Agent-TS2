
import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import { SiteType, Identity, HubPage, Article, SiteTone, ProposedAction } from "../types";

const apiKey = (process.env.API_KEY || "").trim();
const ai = new GoogleGenAI({ apiKey });

/**
 * AIが出力に含めてしまうMarkdownのコードブロック（```html ... ```）を除去する
 */
const stripMarkdown = (text: string): string => {
  return text.replace(/```html/g, "").replace(/```/g, "").trim();
};

const retryWithBackoff = async <T>(
  operation: () => Promise<T>, 
  maxRetries: number = 5, 
  initialDelay: number = 2000,
  signal?: AbortSignal
): Promise<T> => {
  if (!apiKey) {
    throw new Error("APIキーが設定されていません。環境変数 GEMINI_API_KEY を確認してください。");
  }

  let delay = initialDelay;
  for (let i = 0; i < maxRetries; i++) {
    if (signal?.aborted) throw new DOMException("ユーザーによって中断されました", "AbortError");
    
    try {
      return await operation();
    } catch (error: any) {
      if (signal?.aborted) throw new DOMException("ユーザーによって中断されました", "AbortError");
      
      const isNetworkError = error.name === 'TypeError' || error.message?.includes('fetch');
      const isRateLimit = error.status === 429 || error.message?.includes('429');
      const isRetryable = isNetworkError || isRateLimit || error.message?.includes('overloaded');
      
      if (!isRetryable || i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 1.5;
    }
  }
  throw new Error("APIへの接続に失敗しました。時間をおいて再度お試しください。");
};

const getHeaderTemplate = (identity: Identity, prefix: string, siteType: SiteType, hubs: HubPage[]) => {
  const navLinks = hubs
    .filter(h => h.slug !== 'index')
    .map(h => `
      <a href="${prefix}${h.slug}/index.html" class="text-sm font-bold text-slate-600 hover:text-indigo-600 transition-colors whitespace-nowrap">
        ${h.title}
      </a>
    `).join('');

  return `
<header class="fixed top-0 w-full z-50 bg-white/90 backdrop-blur-md border-b border-slate-100">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 h-20 flex justify-between items-center gap-4">
    <a href="${prefix}index.html" class="flex items-center gap-2 sm:gap-3 group shrink-0">
      <div class="w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center text-white font-black shadow-lg" style="background-color: ${identity.themeColor}">
        ${identity.siteName.charAt(0)}
      </div>
      <span class="text-lg sm:text-xl font-black text-slate-800 tracking-tight group-hover:text-indigo-600 transition-colors">
        ${identity.siteName}
      </span>
    </a>
    <nav class="hidden md:flex items-center gap-6 overflow-x-auto no-scrollbar">${navLinks}</nav>
    <div class="flex items-center gap-3">
      <a href="#" class="hidden sm:block px-5 py-2.5 bg-slate-900 text-white text-xs font-black rounded-full hover:bg-indigo-600 transition-all shadow-lg shadow-slate-200 whitespace-nowrap">
        ${siteType === 'Corporate' ? 'お問い合わせ' : 'Contact'}
      </a>
      <button class="md:hidden p-2 text-slate-600" onclick="document.getElementById('mobile-menu').classList.toggle('hidden')">
        <i class="fa-solid fa-bars-staggered text-xl"></i>
      </button>
    </div>
  </div>
  <div id="mobile-menu" class="hidden md:hidden bg-white border-b border-slate-100 p-6 space-y-4 animate-fadeIn">
    <div class="flex flex-col gap-4">${navLinks}</div>
  </div>
</header>`;
};

const getFooterTemplate = (identity: Identity) => `
<footer class="bg-slate-900 text-white py-16 px-6 mt-20">
  <div class="max-w-7xl mx-auto border-b border-white/10 pb-12 mb-12">
    <h4 class="text-2xl font-black mb-6">${identity.siteName}</h4>
    <p class="text-slate-400 leading-relaxed max-w-md font-medium text-sm sm:text-base">${identity.mission}</p>
  </div>
  <p class="text-slate-500 text-xs sm:text-sm font-bold text-center">© 2024 ${identity.siteName}. Built with MySiteGen-Agent.</p>
</footer>`;

export const generateIdentityAgent = async (opinion: string, siteType: SiteType, tone?: SiteTone, signal?: AbortSignal): Promise<Identity> => {
  const toneInstruction = tone ? `トーンは「${tone}」としてください。` : "トーンは内容から最適と思われるものを選択してください。";
  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `以下の理念に基づきブランドアイデンティティを作成してください: "${opinion}"。${toneInstruction}`,
    config: {
      systemInstruction: "あなたはブランド戦略家です。日本語のJSON形式で返してください。toneプロパティには選ばれたトーン(Professional/Creative/Minimal/Vivid/Brutalistのいずれか)を入れてください。",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          siteName: { type: Type.STRING },
          slug: { type: Type.STRING },
          mission: { type: Type.STRING },
          brandDescription: { type: Type.STRING },
          themeColor: { type: Type.STRING },
          tone: { type: Type.STRING, enum: ['Professional', 'Creative', 'Minimal', 'Vivid', 'Brutalist'] }
        },
        required: ["siteName", "slug", "mission", "brandDescription", "themeColor", "tone"]
      }
    }
  }), 5, 2000, signal);
  return JSON.parse(response.text || '{}');
};

export const analyzeSiteIdentityAgent = async (htmlContent: string, signal?: AbortSignal): Promise<Identity> => {
  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `以下のHTMLコンテンツを「改変せず」そのまま分析し、ブランド情報を抽出してください。`,
    config: {
      systemInstruction: "あなたはサイト解析エージェントです。JSONで返してください。",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          siteName: { type: Type.STRING },
          slug: { type: Type.STRING },
          mission: { type: Type.STRING },
          brandDescription: { type: Type.STRING },
          themeColor: { type: Type.STRING },
          tone: { type: Type.STRING, enum: ['Professional', 'Creative', 'Minimal', 'Vivid', 'Brutalist'] }
        },
        required: ["siteName", "slug", "mission", "brandDescription", "themeColor", "tone"]
      }
    }
  }), 5, 2000, signal);
  return JSON.parse(response.text || '{}');
};

export const analyzeRepoStructureAgent = async (filePaths: string[], signal?: AbortSignal): Promise<{ hubs: HubPage[], articles: Article[] }> => {
  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `以下のファイルリストから構造を整理してください。\n${filePaths.join('\n')}`,
    config: {
      systemInstruction: "ウェブサイト構造解析の専門家として、JSON形式で返してください。",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          hubs: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                title: { type: Type.STRING },
                slug: { type: Type.STRING },
                description: { type: Type.STRING }
              },
              required: ["id", "title", "slug", "description"]
            }
          },
          articles: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                hubId: { type: Type.STRING },
                title: { type: Type.STRING },
                slug: { type: Type.STRING },
                createdAt: { type: Type.STRING }
              },
              required: ["id", "hubId", "title", "slug", "createdAt"]
            }
          }
        },
        required: ["hubs", "articles"]
      }
    }
  }), 5, 2000, signal);
  return JSON.parse(response.text || '{"hubs":[], "articles":[]}');
};

export const generateStrategyAgent = async (identity: Identity, siteType: SiteType, signal?: AbortSignal): Promise<{ hubs: HubPage[], rationale: string }> => {
  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `「${identity.siteName}」の戦略を提案。`,
    config: {
      systemInstruction: "UXアーキテクトとしてJSONで返してください。",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          hubs: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { title: { type: Type.STRING }, slug: { type: Type.STRING }, description: { type: Type.STRING } },
              required: ["title", "slug", "description"]
            }
          },
          rationale: { type: Type.STRING }
        },
        required: ["hubs", "rationale"]
      }
    }
  }), 5, 2000, signal);
  const data = JSON.parse(response.text || '{"hubs":[], "rationale":""}');
  return {
    hubs: data.hubs.map((d: any) => ({ ...d, id: Math.random().toString(36).substr(2, 9) })),
    rationale: data.rationale
  };
};

export const generateHtmlAgent = async (
  page: { title: string; description: string; material?: string }, 
  identity: Identity,
  siteType: SiteType,
  allHubs: HubPage[],
  links?: { title: string; url: string }[],
  isRoot: boolean = false,
  referenceHtml?: string,
  customInstruction?: string,
  signal?: AbortSignal
): Promise<string> => {
  const prefix = isRoot ? "./" : "../";
  const header = getHeaderTemplate(identity, prefix, siteType, allHubs);
  const footer = getFooterTemplate(identity);

  const prompt = `
あなたはフロントエンドエンジニアです。
トーン: ${identity.tone} に準拠したHTMLを出力してください。

ページ情報: ${page.title}
サイト名: ${identity.siteName}
テーマカラー: ${identity.themeColor}
${page.material ? `内容のベース資料: ${page.material}` : ""}
${customInstruction ? `追加指示: ${customInstruction}` : ""}

【要件】
1. 完全なHTMLを出力。
2. Tailwind CSS (CDN) を使用。
3. ヘッダー: ${header}
4. フッター: ${footer}
5. 返答はHTMLのみ。`;

  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt
  }), 5, 2000, signal);
  
  return stripMarkdown(response.text || "<html><body>ページ生成に失敗しました。</body></html>");
};

/**
 * デザイン調整の前に、どのように修正するか計画を立てるエージェント
 */
export const generateTunePlanAgent = async (
  instruction: string,
  identity: Identity,
  signal?: AbortSignal
): Promise<{ planSummary: string; tasks: string[] }> => {
  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `指示: ${instruction}\nサイトトーン: ${identity.tone}`,
    config: {
      systemInstruction: "Webサイト改善のプランナーとして、この修正指示を達成するための具体的な技術的ステップを3つ〜5つのリストで提示してください。JSONで返してください。",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          planSummary: { type: Type.STRING, description: "修正計画の全体概要" },
          tasks: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "実行する具体的なタスクのリスト" 
          }
        },
        required: ["planSummary", "tasks"]
      }
    }
  }), 5, 2000, signal);
  return JSON.parse(response.text || '{"planSummary": "", "tasks": []}');
};

export const tunePageDesignAgent = async (
  currentHtml: string,
  instruction: string,
  identity: Identity,
  signal?: AbortSignal
): Promise<string> => {
  const prompt = `
以下のHTMLのデザインを修正してください。
指示: ${instruction}
トーン: ${identity.tone}

【要件】
1. コンテンツやリンク構造は壊さないでください。
2. Tailwind CSSのクラスを調整してください。
3. 出力はHTMLのみ。

現在のHTML:
${currentHtml}`;

  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt
  }), 5, 2000, signal);
  
  return stripMarkdown(response.text || currentHtml);
};

export const chatHelpAgent = async (message: string, mode: 'nav' | 'request' | 'operation', signal?: AbortSignal): Promise<string> => {
  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: message,
    config: { systemInstruction: "MySiteGen-Agentの案内ボットです。" }
  }), 5, 2000, signal);
  return response.text || "回答を生成できませんでした。";
};

export const chatOperationAgent = async (
  message: string, 
  identity: Identity,
  signal?: AbortSignal
): Promise<{ reply: string, proposedAction?: ProposedAction }> => {
  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: message,
    config: {
      systemInstruction: "サイト改善プロフェッショナルです。JSON形式で具体的な提案を行ってください。",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          reply: { type: Type.STRING },
          proposedAction: {
             type: Type.OBJECT,
             properties: {
               title: { type: Type.STRING },
               description: { type: Type.STRING },
               instruction: { type: Type.STRING },
               target: { type: Type.STRING }
             },
             required: ["title", "description", "instruction", "target"]
          }
        },
        required: ["reply"]
      }
    }
  }), 5, 2000, signal);
  return JSON.parse(response.text || '{"reply": "エラー"}');
};

export const getChatSuggestions = async (history: { role: 'bot' | 'user'; text: string }[], signal?: AbortSignal): Promise<string[]> => {
  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `次のおすすめ質問を考えて。`,
    config: { responseMimeType: "application/json", responseSchema: { type: Type.ARRAY, items: { type: Type.STRING } } }
  }), 5, 2000, signal);
  return JSON.parse(response.text || '[]');
};

export const generateReadmeAgent = async (identity: Identity, signal?: AbortSignal): Promise<string> => {
  const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `README.md for ${identity.siteName}`,
  }), 5, 2000, signal);
  return (response.text || "").replace(/```markdown/i, "").replace(/```/i, "").trim();
};
