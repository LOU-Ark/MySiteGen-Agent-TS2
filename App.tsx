
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ProjectState, SiteType, SiteTone, Identity, HubPage, Article, GitHubConfig, ExecutionTask, ProposedAction } from './types';
import * as gemini from './services/geminiService';
import * as github from './services/githubService';
import AnalysisChart from './components/AnalysisChart';

const STORAGE_KEY = 'mysitegen_state_v4';

// ワークフロー定義
interface WorkflowStep {
  id: string;
  label: string;
  description: string;
  statuses: ProjectState['status'][];
}

interface WorkflowDefinition {
  title: string;
  steps: WorkflowStep[];
}

const WORKFLOWS: Record<string, WorkflowDefinition> = {
  build: {
    title: "サイト新規構築フロー",
    steps: [
      { id: 'phase1', label: 'ブランド定義', description: 'AIによるアイデンティティ策定', statuses: ['building_identity'] },
      { id: 'phase2', label: '戦略・設計', description: 'サイト構造とUXの設計', statuses: ['generating_strategy'] },
      { id: 'phase3', label: '実装・構築', description: 'HTML/CSSコーディングと生成', statuses: ['generating_hubs'] },
      { id: 'phase4', label: '仕上げ', description: '統合処理と最終調整', statuses: ['ready'] }
    ]
  },
  deploy: {
    title: "GitHubデプロイフロー",
    steps: [
      { id: 'phase1', label: 'リポジトリ準備', description: 'リモートリポジトリの作成・確認', statuses: ['creating_repo'] },
      { id: 'phase2', label: 'アセット転送', description: 'ファイルのプッシュとコミット', statuses: ['pushing_files'] },
      { id: 'phase3', label: '公開設定', description: 'GitHub Pagesの有効化', statuses: ['enabling_pages', 'deployed'] }
    ]
  },
  import: {
    title: "リポジトリ復元フロー",
    steps: [
      { id: 'phase1', label: 'リソース取得', description: 'リポジトリ情報の解析', statuses: ['importing'] },
      { id: 'phase2', label: '構造分析', description: 'HTML解析とアイデンティティ抽出', statuses: ['analyzing_site'] }
    ]
  },
  tune: {
    title: "デザイン調整フロー",
    steps: [
      { id: 'planning', label: '作業計画策定', description: 'AIによる指示の解析とプラン構築', statuses: ['tuning_design'] },
      { id: 'execution', label: 'デザイン適用', description: '各ページへのHTMLリファクタリング', statuses: ['tuning_design'] }
    ]
  }
};

const tones: { label: string; value: SiteTone; icon: string }[] = [
  { label: 'プロフェッショナル', value: 'Professional', icon: 'fa-briefcase' },
  { label: 'クリエイティブ', value: 'Creative', icon: 'fa-palette' },
  { label: 'ミニマル', value: 'Minimal', icon: 'fa-leaf' },
  { label: 'ビビッド', value: 'Vivid', icon: 'fa-bolt' },
  { label: 'ブルータリズム', value: 'Brutalist', icon: 'fa-cubes' },
];

const initialHelpPrompts = [
  { label: "使い方は？", query: "このアプリの基本的な使い方を教えてください。" },
  { label: "全ページ一括反映", query: "デザイン変更を全ページに一括反映する方法は？" },
  { label: "実績の追加方法", query: "新しいプロジェクトの実績をページとして追加するには？" },
];

// Added helper to safely inject preview scripts or handle links within the iframe
const injectPreviewScript = (html?: string): string => {
  if (!html) return "";
  return html;
};

const App: React.FC = () => {
  const [state, setState] = useState<ProjectState>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
    return {
      opinion: "テクノロジーは人間の創造性を拡張し、共感を生むためのツールであるべきだ。",
      siteType: 'Personal',
      status: 'idle',
      hubs: [],
      articles: [],
      gtmId: '',
      adsenseId: '',
      githubConfig: { token: '', repo: '', branch: 'main', path: 'docs' },
      executionPlan: [],
      currentDetail: null
    };
  });

  const [activeTab, setActiveTab] = useState<'build' | 'dashboard' | 'preview'>('build');
  const [selectedHubId, setSelectedHubId] = useState<string | null>(null);
  const [selectedTone, setSelectedTone] = useState<SiteTone | null>(null);
  const [tuningTargetId, setTuningTargetId] = useState<string>("all");
  const [tuningInstruction, setTuningInstruction] = useState("");
  
  const [showImport, setShowImport] = useState(false);
  const [importRepo, setImportRepo] = useState("");
  const [importToken, setImportToken] = useState("");

  const [isBotOpen, setIsBotOpen] = useState(false);
  const [botMode, setBotMode] = useState<'nav' | 'request' | 'operation'>('nav');
  const [chatHistory, setChatHistory] = useState<{ role: 'bot' | 'user'; text: string; proposedAction?: ProposedAction }[]>([
    { role: 'bot', text: 'こんにちは！案内役のAIです。' }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [isBotThinking, setIsBotThinking] = useState(false);
  const [suggestedQuestions, setSuggestedQuestions] = useState<{ label: string; query: string }[]>(initialHelpPrompts);

  const [showProjectModal, setShowProjectModal] = useState(false);
  const [projectMaterial, setProjectMaterial] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const botRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const planContainerRef = useRef<HTMLDivElement>(null);
  const activeTaskRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    if (activeTaskRef.current) {
      activeTaskRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [state.executionPlan]);

  useEffect(() => {
    if (activeTab === 'preview' && !selectedHubId && state.hubs.length > 0) {
      const home = state.hubs.find(h => h.slug === 'index') || state.hubs[0];
      setSelectedHubId(home.id);
    }
  }, [activeTab, selectedHubId, state.hubs]);

  const updateState = (updates: Partial<ProjectState>) => setState(prev => ({ ...prev, ...updates }));
  const updateGithubConfig = (updates: Partial<GitHubConfig>) => setState(prev => ({ ...prev, githubConfig: { ...prev.githubConfig, ...updates } }));

  const setTaskStatus = (id: string, status: ExecutionTask['status']) => {
    setState(prev => ({
      ...prev,
      executionPlan: prev.executionPlan.map(t => t.id === id ? { ...t, status } : t)
    }));
  };

  const startTask = () => {
    abortControllerRef.current = new AbortController();
    return abortControllerRef.current.signal;
  };

  const handleAbort = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    updateState({ status: state.identity ? 'ready' : 'idle', executionPlan: [], currentDetail: null });
  };

  // Added helper to determine the current workflow information based on state.status
  const getCurrentWorkflowInfo = useCallback(() => {
    for (const key in WORKFLOWS) {
      const def = WORKFLOWS[key];
      const stepIndex = def.steps.findIndex(step => step.statuses.includes(state.status));
      if (stepIndex !== -1) return { def, currentStepIndex: stepIndex };
    }
    return null;
  }, [state.status]);

  // Added missing handleBotSend function for AI interaction
  const handleBotSend = async (overrideQuery?: string) => {
    const query = overrideQuery || chatInput;
    if (!query.trim() || isBotThinking) return;

    setChatHistory(prev => [...prev, { role: 'user', text: query }]);
    setChatInput("");
    setIsBotThinking(true);

    try {
      const response = await gemini.chatOperationAgent(query, state.identity || { 
        siteName: 'MySite', slug: 'mysite', mission: '', brandDescription: '', themeColor: '#4f46e5' 
      });
      setChatHistory(prev => [...prev, { 
        role: 'bot', 
        text: response.reply, 
        proposedAction: response.proposedAction 
      }]);
    } catch (e) {
      setChatHistory(prev => [...prev, { role: 'bot', text: '申し訳ありません。回答の生成中にエラーが発生しました。' }]);
    } finally {
      setIsBotThinking(false);
    }
  };

  const handleInitialBuild = async () => {
    const signal = startTask();
    try {
      updateState({ 
        status: 'building_identity',
        executionPlan: [
          { id: 'identity', label: 'ブランドコンセプトの策定', status: 'running' },
          { id: 'strategy', label: 'サイト構造・戦略の設計', status: 'pending' },
        ],
        currentDetail: 'AIによる分析を実行中...'
      });

      const identity = await gemini.generateIdentityAgent(state.opinion, state.siteType, selectedTone || undefined, signal);
      setTaskStatus('identity', 'completed');
      
      setTaskStatus('strategy', 'running');
      updateState({ identity, status: 'generating_strategy', currentDetail: 'サイト構成案を生成中...' });
      const { hubs, rationale } = await gemini.generateStrategyAgent(identity, state.siteType, signal);
      setTaskStatus('strategy', 'completed');
      
      const hubTasks: ExecutionTask[] = hubs.map(h => ({ 
        id: `build-${h.id}`, label: `生成: ${h.title}`, status: 'pending', groupId: 'gen-pages', groupLabel: '全ページの生成プロセス'
      }));
      hubTasks.push({ id: 'finalize-index', label: 'トップページの統合', status: 'pending' });

      updateState({ 
        hubs, 
        status: 'generating_hubs', 
        strategyRationale: rationale,
        executionPlan: [...state.executionPlan, ...hubTasks],
        currentDetail: 'ページ生成プロセスを開始...'
      });

      const updatedHubs: HubPage[] = [];
      for (const h of hubs) {
        if (signal.aborted) return;
        setTaskStatus(`build-${h.id}`, 'running');
        updateState({ currentDetail: `HTMLコーディング中: ${h.slug}/index.html` });
        const html = await gemini.generateHtmlAgent(h, identity, state.siteType, hubs, [], false, undefined, undefined, signal);
        updatedHubs.push({ ...h, html });
        setTaskStatus(`build-${h.id}`, 'completed');
      }

      setTaskStatus('finalize-index', 'running');
      const indexHtml = await gemini.generateHtmlAgent(
        { title: identity.siteName, description: identity.mission },
        identity, state.siteType, updatedHubs, updatedHubs.map(h => ({ title: h.title, url: `${h.slug}/index.html` })), true, undefined, undefined, signal
      );
      setTaskStatus('finalize-index', 'completed');
      
      const homeHub = { id: 'home', title: 'ホーム', slug: 'index', description: 'トップページ', html: indexHtml };
      updateState({ hubs: [homeHub, ...updatedHubs], status: 'ready', executionPlan: [], currentDetail: null });
      setSelectedHubId('home');
      setActiveTab('dashboard');
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      updateState({ status: 'idle', executionPlan: [], currentDetail: null });
    }
  };

  const handleTuneDesign = async (overrideInstruction?: string, targetId?: string) => {
    const instruction = overrideInstruction || tuningInstruction;
    const target = targetId || tuningTargetId;
    if (!state.identity || !instruction) return;
    
    const signal = startTask();
    setExpandedGroups({ 'tune-pages': true });
    
    updateState({ 
      status: 'tuning_design', 
      executionPlan: [{ id: 'plan-generation', label: '指示の解析と作業プロセスの決定', status: 'running' }],
      currentDetail: 'ユーザーの要望をエンジニアリング要件へ分解中...'
    });

    try {
      const tunePlan = await gemini.generateTunePlanAgent(instruction, state.identity, signal);
      setTaskStatus('plan-generation', 'completed');

      const taskList: ExecutionTask[] = [];
      const targetsToProcess: {id: string, title: string, html: string, type: 'hub' | 'article'}[] = [];

      if (target === 'all') {
        state.hubs.forEach(h => targetsToProcess.push({id: h.id, title: h.title, html: h.html || "", type: 'hub'}));
        state.articles.forEach(a => targetsToProcess.push({id: a.id, title: a.title, html: a.contentHtml || "", type: 'article'}));
      } else {
        const hub = state.hubs.find(h => h.id === target);
        const art = state.articles.find(a => a.id === target);
        if (hub) targetsToProcess.push({id: hub.id, title: hub.title, html: hub.html || "", type: 'hub'});
        else if (art) targetsToProcess.push({id: art.id, title: art.title, html: art.contentHtml || "", type: 'article'});
      }

      tunePlan.tasks.forEach((step, idx) => {
        taskList.push({ id: `plan-step-${idx}`, label: `【方針】${step}`, status: 'completed' });
      });

      targetsToProcess.forEach(t => {
        taskList.push({ 
          id: `tune-${t.id}`, 
          label: `反映: ${t.title}`, 
          status: 'pending', 
          groupId: 'tune-pages', 
          groupLabel: 'ページのリファクタリング反映' 
        });
      });

      updateState({ executionPlan: [...state.executionPlan, ...taskList] });

      const updatedHubs = [...state.hubs];
      const updatedArticles = [...state.articles];

      for (const t of targetsToProcess) {
        if (signal.aborted) return;
        setTaskStatus(`tune-${t.id}`, 'running');
        updateState({ currentDetail: `リファクタリング実行中: ${t.title}` });
        
        const newHtml = await gemini.tunePageDesignAgent(t.html, instruction, state.identity!, signal);
        
        if (t.type === 'hub') {
          const idx = updatedHubs.findIndex(h => h.id === t.id);
          updatedHubs[idx] = { ...updatedHubs[idx], html: newHtml };
        } else {
          const idx = updatedArticles.findIndex(a => a.id === t.id);
          updatedArticles[idx] = { ...updatedArticles[idx], contentHtml: newHtml };
        }
        
        setTaskStatus(`tune-${t.id}`, 'completed');
      }

      updateState({ hubs: updatedHubs, articles: updatedArticles });
      setTuningInstruction("");

    } catch (e: any) {
      if (e.name === 'AbortError') return;
      console.error(e);
      alert("エラーが発生しました。");
    } finally {
      updateState({ status: 'ready', executionPlan: [], currentDetail: null });
    }
  };

  const handleImport = async () => {
    if (!importRepo || !importToken) return;
    setShowImport(false);
    const signal = startTask();
    
    updateState({ 
      status: 'importing',
      executionPlan: [
        { id: 'fetch-info', label: 'リポジトリ情報の検証', status: 'running' },
        { id: 'fetch-tree', label: 'ディレクトリ構造のスキャン', status: 'pending' },
        { id: 'fetch-content', label: '主要リソースの取得', status: 'pending' },
        { id: 'analyze-brand', label: 'ブランドアイデンティティ解析', status: 'pending' },
        { id: 'analyze-structure', label: 'コンテンツ構造の分析', status: 'pending' },
        { id: 'fetch-full-content', label: '全ページの復元', status: 'pending', groupId: 'import-restore', groupLabel: 'GitHubからの全ページ取得' }
      ],
      currentDetail: `GitHub接続中...`
    });

    try {
      const config: GitHubConfig = { token: importToken, repo: importRepo, branch: 'main', path: 'docs' };
      const details = await github.fetchRepoDetails(config, signal);
      if (details) config.branch = details.default_branch;
      setTaskStatus('fetch-info', 'completed');
      setTaskStatus('fetch-tree', 'running');
      const tree = await github.fetchRepoStructure(config, signal);
      const htmlFiles = tree.filter(f => f.path.endsWith('.html'));
      setTaskStatus('fetch-tree', 'completed');
      setTaskStatus('fetch-content', 'running');
      const indexFile = htmlFiles.find(f => f.path.endsWith('index.html'));
      const indexHtml = indexFile ? await github.fetchFileContent(indexFile.url, config.token, signal) : "";
      setTaskStatus('fetch-content', 'completed');
      setTaskStatus('analyze-brand', 'running');
      const identity = await gemini.analyzeSiteIdentityAgent(indexHtml, signal);
      setTaskStatus('analyze-brand', 'completed');
      setTaskStatus('analyze-structure', 'running');
      const { hubs, articles } = await gemini.analyzeRepoStructureAgent(htmlFiles.map(f => f.path), signal);
      setTaskStatus('analyze-structure', 'completed');

      setTaskStatus('fetch-full-content', 'running');
      setExpandedGroups({ 'import-restore': true });
      const finalHubs: HubPage[] = [];
      for (const hub of hubs) {
        const matchingFile = htmlFiles.find(f => f.path.includes(`${hub.slug}/index.html`)) || (hub.slug === 'index' && indexFile ? indexFile : null);
        if (matchingFile) {
           updateState({ currentDetail: `取得中: ${hub.slug}` });
           const content = await github.fetchFileContent(matchingFile.url, config.token, signal);
           finalHubs.push({ ...hub, html: content });
        } else finalHubs.push(hub);
      }
      setTaskStatus('fetch-full-content', 'completed');

      updateState({ identity, githubConfig: config, status: 'ready', hubs: finalHubs, articles, executionPlan: [], currentDetail: null });
      setSelectedHubId(finalHubs[0]?.id || null);
      setActiveTab('dashboard');
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      updateState({ status: 'idle', executionPlan: [], currentDetail: null });
    }
  };

  const handlePublish = async () => {
    if (!state.githubConfig.repo || !state.githubConfig.token) return;
    const signal = startTask();
    updateState({ 
      status: 'creating_repo',
      executionPlan: [
        { id: 'check-repo', label: 'リポジトリ情報の検証', status: 'running' },
        { id: 'push-files', label: 'ファイルのプッシュ', status: 'pending', groupId: 'push-group', groupLabel: '全ファイルのアップロード' },
        { id: 'enable-pages', label: 'GitHub Pages有効化', status: 'pending' }
      ]
    });

    try {
      const details = await github.fetchRepoDetails(state.githubConfig, signal);
      if (!details) await github.createRepository(state.githubConfig, signal);
      setTaskStatus('check-repo', 'completed');
      setTaskStatus('push-files', 'running');
      setExpandedGroups({ 'push-group': true });
      const readme = await gemini.generateReadmeAgent(state.identity!);
      await github.publishToGithub(state.githubConfig, state.hubs, state.articles, readme, signal, (file) => updateState({ currentDetail: `送信中: ${file}` }));
      setTaskStatus('push-files', 'completed');
      setTaskStatus('enable-pages', 'running');
      await github.enablePages(state.githubConfig, signal);
      setTaskStatus('enable-pages', 'completed');
      updateState({ status: 'deployed', executionPlan: [], currentDetail: null });
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      updateState({ status: 'ready', executionPlan: [], currentDetail: null });
    }
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const renderTaskHistory = () => {
    const groups: Record<string, ExecutionTask[]> = {};
    const ungrouped: ExecutionTask[] = [];

    state.executionPlan.forEach(task => {
      if (task.groupId) {
        if (!groups[task.groupId]) groups[task.groupId] = [];
        groups[task.groupId].push(task);
      } else {
        ungrouped.push(task);
      }
    });

    // Changed JSX.Element to React.ReactElement to resolve namespace error
    const renderedGroups: React.ReactElement[] = [];

    Object.entries(groups).forEach(([groupId, tasks]) => {
      const isExpanded = expandedGroups[groupId];
      const runningCount = tasks.filter(t => t.status === 'running').length;
      const completedCount = tasks.filter(t => t.status === 'completed').length;
      const totalCount = tasks.length;
      const groupLabel = tasks[0].groupLabel || groupId;
      const isAnyRunning = runningCount > 0;

      renderedGroups.push(
        <div key={groupId} className={`border rounded-2xl overflow-hidden transition-all duration-300 ${isAnyRunning ? 'border-indigo-500 bg-indigo-50/5' : 'border-white/10'}`}>
          <button onClick={() => toggleGroup(groupId)} className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs ${isAnyRunning ? 'bg-indigo-500 text-white animate-pulse' : completedCount === totalCount ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-400'}`}>
                {isAnyRunning ? <i className="fa-solid fa-sync fa-spin"></i> : completedCount === totalCount ? <i className="fa-solid fa-check"></i> : <i className="fa-solid fa-layer-group"></i>}
              </div>
              <div className="text-left">
                <h6 className="text-sm font-bold">{groupLabel}</h6>
                <p className="text-[10px] text-slate-500 font-mono">{completedCount} / {totalCount} 完了</p>
              </div>
            </div>
            <i className={`fa-solid fa-chevron-${isExpanded ? 'up' : 'down'} text-slate-500 text-xs`}></i>
          </button>
          {isExpanded && (
            <div className="p-2 space-y-1 bg-black/20 border-t border-white/5">
              {tasks.map(task => {
                const isRunning = task.status === 'running';
                return (
                  <div key={task.id} ref={isRunning ? activeTaskRef : null} className={`flex items-center gap-3 p-2 rounded-lg text-xs transition-all ${isRunning ? 'bg-indigo-500/20 text-indigo-400 font-bold' : task.status === 'completed' ? 'text-emerald-400/80' : 'text-slate-500'}`}>
                    {isRunning ? <i className="fa-solid fa-caret-right animate-bounce"></i> : task.status === 'completed' ? <i className="fa-solid fa-check"></i> : <i className="fa-regular fa-circle"></i>}
                    <span className="truncate">{task.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    });

    return (
      <div className="space-y-4">
        {ungrouped.map(task => {
          const isRunning = task.status === 'running';
          return (
            <div key={task.id} ref={isRunning ? activeTaskRef : null} className={`flex items-center gap-4 p-4 rounded-2xl border transition-all ${isRunning ? 'bg-indigo-500/10 border-indigo-500 shadow-lg shadow-indigo-500/10' : task.status === 'completed' ? 'bg-emerald-500/5 border-emerald-500/20' : 'border-white/5 opacity-50'}`}>
               <div className={`w-6 h-6 flex items-center justify-center shrink-0 ${task.status === 'completed' ? 'text-emerald-400' : 'text-indigo-400'}`}>
                 {isRunning ? <i className="fa-solid fa-circle-notch fa-spin"></i> : task.status === 'completed' ? <i className="fa-solid fa-check-circle"></i> : <i className="fa-regular fa-circle"></i>}
               </div>
               <span className="font-mono text-sm">{task.label}</span>
            </div>
          );
        })}
        {renderedGroups}
      </div>
    );
  };

  const workflowInfo = getCurrentWorkflowInfo();

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-50 font-sans">
      {(state.status !== 'idle' && state.status !== 'ready' && state.status !== 'deployed') && workflowInfo && (
        <div className="fixed inset-0 z-[100] bg-slate-900/90 backdrop-blur-lg overflow-y-auto">
          <div className="min-h-full flex items-center justify-center p-4 py-12">
            <div className="bg-white rounded-[2rem] w-full max-w-5xl shadow-2xl flex flex-col md:flex-row md:h-[600px] overflow-hidden animate-fadeIn relative">
             <div className="w-full md:w-1/3 bg-slate-50 p-8 border-r border-slate-100 flex flex-col">
                <div className="mb-8">
                  <span className="text-[10px] font-black uppercase tracking-widest text-indigo-500 bg-indigo-50 px-3 py-1 rounded-full">Executing Workflow</span>
                  <h3 className="text-2xl font-black mt-3 text-slate-900">{workflowInfo.def.title}</h3>
                </div>
                <div className="space-y-6 overflow-y-auto custom-scrollbar pr-2">
                  {workflowInfo.def.steps.map((step, idx) => {
                    const isActive = idx === workflowInfo.currentStepIndex;
                    const isCompleted = idx < workflowInfo.currentStepIndex;
                    return (
                      <div key={step.id} className={`relative pl-8 transition-all duration-500 ${isActive ? 'opacity-100 scale-105 origin-left' : isCompleted ? 'opacity-60' : 'opacity-30'}`}>
                         {idx !== workflowInfo.def.steps.length - 1 && (
                           <div className={`absolute left-[11px] top-8 bottom-[-24px] w-0.5 ${isCompleted ? 'bg-emerald-300' : 'bg-slate-200'}`}></div>
                         )}
                         <div className={`absolute left-0 top-1 w-6 h-6 rounded-full flex items-center justify-center border-2 z-10 bg-white ${isActive ? 'border-indigo-600 text-indigo-600 animate-pulse' : isCompleted ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 text-slate-300'}`}>
                           {isCompleted ? <i className="fa-solid fa-check text-[10px]"></i> : isActive ? <div className="w-2 h-2 rounded-full bg-indigo-600"></div> : <div className="w-2 h-2 rounded-full bg-slate-200"></div>}
                         </div>
                         <div>
                           <h4 className={`text-sm font-bold ${isActive ? 'text-indigo-900' : 'text-slate-700'}`}>{step.label}</h4>
                           <p className="text-xs text-slate-500 mt-1">{step.description}</p>
                         </div>
                      </div>
                    );
                  })}
                </div>
                <div className="pt-6 mt-auto">
                   <button onClick={handleAbort} className="w-full py-3 bg-white border-2 border-slate-200 text-slate-500 text-xs font-black rounded-xl hover:bg-red-50 hover:border-red-200 hover:text-red-500 transition-all">中断</button>
                </div>
             </div>
             <div className="w-full md:w-auto flex-1 bg-slate-900 text-white p-8 flex flex-col relative overflow-hidden min-h-[500px]">
                <div className="mb-6 z-10 border-b border-white/10 pb-6">
                  <h4 className="text-sm font-mono text-indigo-400 mb-2">Current Activity</h4>
                  <div className="bg-black/30 rounded-xl p-4 border border-white/10 backdrop-blur-sm">
                     <p className="text-lg font-bold font-mono animate-fadeIn"><span className="text-indigo-400 mr-2">$</span>{state.currentDetail || "Initializing..."}<span className="animate-pulse ml-1">_</span></p>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 z-10" ref={planContainerRef}>
                   <h5 className="text-[10px] font-black uppercase text-slate-500 mb-4 sticky top-0 bg-slate-900 py-2">Execution Plan</h5>
                   {renderTaskHistory()}
                </div>
             </div>
          </div>
          </div>
        </div>
      )}

      <header className="bg-white border-b px-8 py-4 flex justify-between items-center z-50 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white"><i className="fa-solid fa-wand-magic-sparkles text-lg"></i></div>
          <h1 className="font-black text-xl tracking-tighter">MySiteGen<span className="text-indigo-600">エージェント</span></h1>
        </div>
        <nav className="flex bg-slate-100 p-1 rounded-2xl">
          {['build', 'dashboard', 'preview'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab as any)} disabled={tab !== 'build' && !state.identity}
              className={`px-8 py-2.5 text-xs font-black rounded-xl transition-all ${activeTab === tab ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
              {tab === 'build' ? 'サイト構築' : tab === 'dashboard' ? '運用管理' : 'プレビュー'}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 overflow-auto p-8">
        <div className="max-w-6xl mx-auto h-full">
          {activeTab === 'build' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start h-full">
              <section className="bg-white p-10 rounded-[2.5rem] border shadow-sm space-y-10">
                <div className="space-y-4">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">理念・ミッションステートメント</label>
                  <textarea className="w-full h-40 p-6 border-2 border-slate-50 rounded-[2rem] bg-slate-50 outline-none focus:border-indigo-500 text-sm" 
                    value={state.opinion} onChange={e => updateState({ opinion: e.target.value })} 
                    placeholder="例: 私たちはテクノロジーで地方の課題を解決します。" />
                </div>
                <div className="grid grid-cols-5 gap-3">
                  {tones.map(t => (
                    <button key={t.value} onClick={() => setSelectedTone(selectedTone === t.value ? null : t.value)} 
                      className={`flex flex-col items-center gap-3 p-4 rounded-2xl border-2 transition-all ${selectedTone === t.value ? 'border-indigo-600 bg-indigo-50 text-indigo-600' : 'border-slate-50 bg-slate-50 text-slate-300'}`}>
                      <i className={`fa-solid ${t.icon} text-xl`}></i>
                      <span className="text-[8px] font-black">{t.label}</span>
                    </button>
                  ))}
                </div>
                <div className="flex gap-4 pt-4">
                  <button onClick={handleInitialBuild} className="flex-1 py-5 bg-slate-900 text-white rounded-[2rem] font-black hover:bg-indigo-600 transition-all">新規構築を開始</button>
                  <button onClick={() => setShowImport(true)} className="px-10 bg-white border-2 border-slate-100 rounded-[2rem] font-black text-xs text-slate-500 border-dashed">GitHubから復元</button>
                </div>
              </section>
              <div className="flex flex-col justify-center items-center h-full">
                {state.identity ? (
                  <div className="bg-white p-12 rounded-[3rem] border shadow-lg w-full animate-fadeIn">
                     <div className="flex items-center gap-8 mb-10 border-b pb-10">
                       <div className="w-24 h-24 rounded-[2rem] flex items-center justify-center text-white text-4xl font-black shadow-xl" style={{ backgroundColor: state.identity.themeColor }}>{state.identity.siteName[0]}</div>
                       <div>
                         <h3 className="text-3xl font-black text-slate-900 mb-1">{state.identity.siteName}</h3>
                         <p className="text-indigo-600 font-black text-sm uppercase">{state.identity.mission}</p>
                       </div>
                     </div>
                     <p className="text-slate-500 text-lg leading-relaxed mb-8">{state.identity.brandDescription}</p>
                     <button onClick={() => setActiveTab('dashboard')} className="px-5 py-2 bg-slate-900 text-white text-[10px] font-black rounded-full uppercase tracking-widest hover:bg-indigo-600">管理画面へ <i className="fa-solid fa-arrow-right ml-1"></i></button>
                  </div>
                ) : (
                  <div className="text-slate-200 text-center animate-pulse"><i className="fa-solid fa-fingerprint text-9xl mb-8"></i><p className="font-black text-sm uppercase tracking-widest">Identity Awaiting</p></div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'dashboard' && state.identity && (
            <div className="space-y-8 animate-fadeIn pb-32">
               <section className="bg-slate-900 text-white p-12 rounded-[3rem] shadow-xl relative overflow-hidden">
                  <div className="mb-8 relative z-10"><h2 className="text-2xl font-black mb-2 flex items-center gap-3"><i className="fa-brands fa-github"></i> GitHubデプロイ設定</h2><p className="text-sm text-slate-400">docs/ フォルダ以下に静的サイトを公開します。</p></div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-end relative z-10">
                    <div className="space-y-4">
                      <input type="text" className="w-full p-4 bg-white/10 border border-white/10 rounded-2xl text-white font-bold text-sm" placeholder="username/repo" value={state.githubConfig.repo} onChange={e => updateGithubConfig({ repo: e.target.value })} />
                      <input type="password" className="w-full p-4 bg-white/10 border border-white/10 rounded-2xl text-white font-bold text-sm" placeholder="GitHub Token" value={state.githubConfig.token} onChange={e => updateGithubConfig({ token: e.target.value })} />
                    </div>
                    <button onClick={handlePublish} className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black shadow-lg hover:bg-indigo-500">プッシュ & 公開</button>
                  </div>
               </section>

               <section className="bg-gradient-to-br from-indigo-50 via-white to-blue-50 p-12 rounded-[3rem] border-2 border-indigo-100">
                  <div className="mb-8"><h2 className="text-2xl font-black mb-2 text-slate-900"><i className="fa-solid fa-swatchbook text-indigo-500"></i> デザイン調整</h2><p className="text-sm text-slate-500 font-medium">全ページの見た目や機能をAIで一括変更します。</p></div>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
                    <select className="p-5 border-2 border-white rounded-2xl bg-white shadow-sm font-bold text-sm" value={tuningTargetId} onChange={e => setTuningTargetId(e.target.value)}>
                      <option value="all">全ページ一括</option>
                      {state.hubs.map(h => <option key={h.id} value={h.id}>{h.title}</option>)}
                    </select>
                    <div className="md:col-span-2">
                      <input type="text" className="w-full p-5 border-2 border-white rounded-2xl bg-white shadow-sm font-bold text-sm" placeholder="例: 全体をダークモードに" value={tuningInstruction} onChange={e => setTuningInstruction(e.target.value)} />
                    </div>
                    <button onClick={() => handleTuneDesign()} className="w-full py-5 bg-slate-900 text-white rounded-2xl font-black">反映開始</button>
                  </div>
               </section>

               <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="p-12 bg-white border rounded-[3rem] border-slate-100 flex flex-col">
                    <h3 className="text-xl font-black mb-8 flex items-center gap-3"><i className="fa-solid fa-chart-pie text-slate-300"></i> 構造分析</h3>
                    <div className="flex-1"><AnalysisChart data={state.hubs.map(h => ({ name: h.title, count: state.articles.filter(a => a.hubId === h.id).length + 1 }))} /></div>
                  </div>
                  <button onClick={() => setShowProjectModal(true)} className="p-12 bg-white border rounded-[3rem] hover:shadow-2xl transition-all text-left group border-slate-100">
                    <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-3xl flex items-center justify-center mb-8"><i className="fa-solid fa-plus text-2xl"></i></div>
                    <h3 className="text-2xl font-black mb-3">実績をページ化</h3>
                    <p className="text-sm text-slate-500">資料から高品質な紹介ページを生成。</p>
                  </button>
               </div>
            </div>
          )}

          {activeTab === 'preview' && (
            <div className="h-full bg-white rounded-[3rem] shadow-2xl border border-slate-100 overflow-hidden flex flex-col animate-fadeIn">
               <div className="bg-slate-50 px-8 py-4 border-b flex justify-between items-center text-[10px] font-black text-slate-400">
                  <div className="flex gap-2"><div className="w-3 h-3 rounded-full bg-rose-400"></div><div className="w-3 h-3 rounded-full bg-amber-400"></div><div className="w-3 h-3 rounded-full bg-emerald-400"></div></div>
                  <div className="flex-1 mx-8 max-w-3xl relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none">
                      <i className="fa-solid fa-lock text-[10px] text-emerald-500"></i>
                      <span className="text-slate-400 font-mono">mysite-preview.local/</span>
                    </div>
                    <select value={selectedHubId || ''} onChange={(e) => setSelectedHubId(e.target.value)} className="w-full pl-[170px] pr-10 py-2 bg-white border border-slate-200 rounded-full font-mono text-slate-600 shadow-inner appearance-none cursor-pointer outline-none focus:border-indigo-300 transition-colors">
                      <optgroup label="セクション (ハブ)">
                        {state.hubs.map(h => (<option key={h.id} value={h.id}>{h.slug === 'index' ? 'index.html' : `${h.slug}/index.html`}</option>))}
                      </optgroup>
                      {state.articles.length > 0 && (
                        <optgroup label="コンテンツ (アーティクル)">
                          {state.articles.map(a => {
                            const parent = state.hubs.find(h => h.id === a.hubId);
                            const path = (parent && parent.slug !== 'index') ? `${parent.slug}/${a.slug}.html` : `articles/${a.slug}.html`;
                            return (<option key={a.id} value={a.id}>{path}</option>);
                          })}
                        </optgroup>
                      )}
                    </select>
                  </div>
                  <button onClick={() => { const current = selectedHubId; setSelectedHubId(null); setTimeout(() => setSelectedHubId(current), 10); }} className="text-slate-400 hover:text-indigo-600 transition-colors"><i className="fa-solid fa-rotate-right"></i></button>
               </div>
               <iframe key={selectedHubId} className="flex-1 w-full border-none" srcDoc={injectPreviewScript(state.hubs.find(h => h.id === selectedHubId)?.html || state.articles.find(a => a.id === selectedHubId)?.contentHtml)} />
            </div>
          )}
        </div>
      </main>

      <div className="fixed bottom-6 right-6 z-[200] flex flex-col items-end gap-5" ref={botRef}>
        {isBotOpen && (
          <div className="w-80 sm:w-[420px] h-[600px] bg-white rounded-[2.5rem] shadow-[0_20px_50px_-12px_rgba(0,0,0,0.15)] border border-slate-100 overflow-hidden flex flex-col animate-slideUp">
            <div className="bg-slate-900 p-8 text-white flex justify-between items-center shrink-0">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-indigo-500 rounded-2xl flex items-center justify-center text-xl shadow-lg shadow-indigo-500/20"><i className="fa-solid fa-robot"></i></div>
                <div>
                  <h4 className="font-black tracking-tight text-lg">MySiteエージェント</h4>
                </div>
              </div>
              <button onClick={() => setIsBotOpen(false)} className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors"><i className="fa-solid fa-xmark text-xl"></i></button>
            </div>
            <div className="flex-1 overflow-auto p-6 space-y-6 bg-slate-50/50">
              {chatHistory.map((m, i) => (
                <div key={i} className={`flex flex-col gap-2 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div className={`max-w-[85%] p-4 rounded-3xl text-sm font-medium leading-relaxed shadow-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-100 text-slate-700'}`}>{m.text}</div>
                </div>
              ))}
            </div>
            <div className="p-6 bg-white border-t shrink-0">
              <div className="flex items-center gap-3">
                <input type="text" className="w-full p-4 bg-slate-50 rounded-2xl text-sm font-medium outline-none border border-transparent transition-all pr-12" placeholder="質問する..." value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleBotSend()} />
                <button onClick={() => handleBotSend()} className="w-10 h-10 bg-indigo-600 text-white rounded-xl shadow-lg flex items-center justify-center"><i className="fa-solid fa-paper-plane text-xs"></i></button>
              </div>
            </div>
          </div>
        )}
        <button onClick={() => setIsBotOpen(!isBotOpen)} className="w-12 h-12 bg-indigo-600 text-white rounded-[1.5rem] shadow-xl flex items-center justify-center text-xl hover:scale-110 active:scale-95 transition-all group relative">
          <i className={`fa-solid ${isBotOpen ? 'fa-xmark' : 'fa-comments'}`}></i>
        </button>
      </div>

      {showImport && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-slate-900/80 backdrop-blur-md animate-fadeIn">
          <div className="bg-white p-10 rounded-[3rem] max-w-md w-full shadow-2xl space-y-8">
            <div className="text-center"><i className="fa-brands fa-github text-6xl mb-6"></i><h3 className="text-2xl font-black">既存サイトの復元</h3></div>
            <div className="space-y-6">
              <input type="text" className="w-full p-5 border-2 border-slate-50 rounded-2xl bg-slate-50 font-bold text-sm" placeholder="username/repo" value={importRepo} onChange={e => setImportRepo(e.target.value)} />
              <input type="password" className="w-full p-5 border-2 border-slate-50 rounded-2xl bg-slate-50 font-bold text-sm" placeholder="GitHub Token" value={importToken} onChange={e => setImportToken(e.target.value)} />
            </div>
            <div className="flex gap-4 pt-4">
              <button onClick={() => setShowImport(false)} className="flex-1 py-5 font-black text-xs bg-slate-100 rounded-[2rem]">キャンセル</button>
              <button onClick={handleImport} className="flex-[2] py-5 bg-indigo-600 text-white font-black text-xs rounded-[2rem]">読み込み開始</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
