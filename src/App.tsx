import { useEffect, useRef, useCallback, useState } from 'react'

// ---- Constants ----
const CANVAS_W = 800
const CANVAS_H = 400
const GROUND_Y = 340
const GRAVITY = 0.2
const JUMP_FORCE = -10
const PLAYER_W = 30
const PLAYER_H = 80
const PLAYER_X = 80
const BLOCK_SIZE = 30
const INITIAL_SPEED = 2
const SPEED_INCREMENT = 0.0007
const TIME_SCALE = 2.0  // ゲーム全体の速度倍率。上げると速くなる（GRAVITY/JUMP_FORCE調整不要）
const MIN_SPAWN_DISTANCE = 350  // 障害物間の最小空間距離 (px)
const SPAWN_DISTANCE_RANGE = 400 // 最小距離に加えるランダム幅 (px)

// ---- Taunt messages on game over ----
const TAUNT_MESSAGES = [
  '全力コミットしていただいて良いですか?',
  'まず目標は1ランクアップの視点ですね',
  '道のり楽しめてなさそう...',
  '「こと」はゴールですよ。文を読む必要はありません',
  'これでは表面は任せられないです...',
]
// ジャンプ持続フレーム (物理ベース・初速時): 2 * |JUMP_FORCE| / GRAVITY
// 速度に応じて gravity ∝ k², jumpForce ∝ k のためジャンプ高さ一定・対空距離一定
const JUMP_DURATION_FRAMES = Math.ceil(2 * Math.abs(JUMP_FORCE) / GRAVITY)

// スピード係数に応じた動的物理パラメータ
function getDynamicPhysics(currentSpeed: number) {
  const k = currentSpeed / INITIAL_SPEED
  return {
    gravity: GRAVITY * k * k,
    jumpForce: JUMP_FORCE * k,
  }
}

// ---- Story lines (distraction) ----
const STORY_LINES = [
  '',
  '',
  'DeNAに入社する直前に、',
  'オーストラリアに旅行に行ったんですよ。',
  '服も色々持って行ったのですが、',
  '日本っぽい服も一着だけ持って行きました。',
  '結構可愛い小鳥が描かれており、',
  '鳥の名前も書かれていました。',
  'Japanese Great Tits (日本のシジュウカラ)',
  '......',
  'でも、Titsって、',
  '胸 って意味もあったんですね。',
  'Japanese Great Tits (再掲)',
  '僕の思い出と引き換えに、',
  'オーストラリアにデライトを届けたお話でした。'
]

// ---- Types ----
interface Obstacle {
  x: number
  blocks: number // 1–3 stacked blocks
}

type GameState = 'title' | 'playing' | 'gameover' | 'clear'

// ---- Helper: AABB collision ----
function collides(
  px: number, py: number, pw: number, ph: number,
  ox: number, oy: number, ow: number, oh: number,
  shrink = 6,
): boolean {
  return (
    px + shrink < ox + ow &&
    px + pw - shrink > ox &&
    py + shrink < oy + oh &&
    py + ph - shrink > oy
  )
}

// ---- Draw stick figure ----
function drawStickMan(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  legPhase: number,
  _isAir: boolean,
) {
  const cx = px + PLAYER_W / 2
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2

  // Head
  const headR = 20
  const headCY = py + headR
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.arc(cx, headCY, headR, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.beginPath()
  ctx.arc(cx, headCY, headR, 0, Math.PI * 2)
  ctx.stroke()

  // Face: G=left eye, E=right eye, U=mouth
  ctx.fillStyle = '#fff'
  ctx.font = `bold 9px ${PIXEL_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('G', cx - 6, headCY - 7)
  ctx.fillText('E', cx + 6, headCY - 7)
  ctx.fillText('U', cx, headCY + 7)
  ctx.textBaseline = 'alphabetic'

  // Body
  ctx.strokeStyle = '#fff'
  ctx.beginPath()
  ctx.moveTo(cx, py + 40)
  ctx.lineTo(cx, py + 58)
  ctx.stroke()

  // Arms: both bent 90°, forearms alternate up/down (∟¬ ↔ ⌐r)
  const shoulderY = py + 44
  const elbowX_L = cx - 16
  const elbowX_R = cx + 16
  const leftDir = Math.sin(legPhase) >= 0 ? 13 : -13  // left forearm: down or up
  const rightDir = -leftDir                            // right forearm: opposite
  // Left arm ∟ or ⌐
  ctx.beginPath()
  ctx.moveTo(cx, shoulderY)
  ctx.lineTo(elbowX_L, shoulderY)
  ctx.lineTo(elbowX_L, shoulderY + leftDir)
  ctx.stroke()
  // Right arm ¬ or r
  ctx.beginPath()
  ctx.moveTo(cx, shoulderY)
  ctx.lineTo(elbowX_R, shoulderY)
  ctx.lineTo(elbowX_R, shoulderY + rightDir)
  ctx.stroke()

  // Legs
  const swing = _isAir ? 5 : Math.sin(legPhase) * 9
  ctx.beginPath()
  ctx.moveTo(cx, py + 58)
  ctx.lineTo(cx - 9 + swing, py + PLAYER_H)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx, py + 58)
  ctx.lineTo(cx + 9 - swing, py + PLAYER_H)
  ctx.stroke()
}

// ---- Draw stacked blocks ----
function drawObstacle(
  ctx: CanvasRenderingContext2D,
  o: Obstacle,
) {
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  for (let i = 0; i < o.blocks; i++) {
    const by = GROUND_Y - (i + 1) * BLOCK_SIZE
    ctx.strokeRect(o.x + 1, by + 1, BLOCK_SIZE - 2, BLOCK_SIZE - 2)
    // Inner pixel cross for retro texture
    ctx.beginPath()
    ctx.moveTo(o.x + 1, by + 1)
    ctx.lineTo(o.x + BLOCK_SIZE - 1, by + BLOCK_SIZE - 1)
    ctx.moveTo(o.x + BLOCK_SIZE - 1, by + 1)
    ctx.lineTo(o.x + 1, by + BLOCK_SIZE - 1)
    ctx.stroke()
  }
}

const PIXEL_FONT = '"Press Start 2P", monospace'

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const state = useRef<GameState>('title')
  const playerY = useRef(GROUND_Y - PLAYER_H)
  const velY = useRef(0)
  const onGround = useRef(true)
  const obstacles = useRef<Obstacle[]>([])
  const frameCount = useRef(0)
  const score = useRef(0)
  const highScore = useRef(0)
  const speed = useRef(INITIAL_SPEED)
  const spawnTimer = useRef(0)
  const triggerClear = useRef(false)
  const tauntMessage = useRef('')
  const lastTime = useRef(0)

  const [uiState, setUiState] = useState<GameState>('title')
  const [storyIndex, setStoryIndex] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setStoryIndex(i => {
        if (i >= STORY_LINES.length - 1) {
          triggerClear.current = true
          return i
        }
        return i + 1
      })
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  const resetGame = useCallback(() => {
    playerY.current = GROUND_Y - PLAYER_H
    velY.current = 0
    onGround.current = true
    obstacles.current = []
    frameCount.current = 0
    score.current = 0
    speed.current = INITIAL_SPEED
    spawnTimer.current = 0
    lastTime.current = 0
    state.current = 'playing'
    setUiState('playing')
    setStoryIndex(0)
  }, [])

  // ---- Input ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.code !== 'ShiftLeft' && e.code !== 'ShiftRight') return
      e.preventDefault()
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        if (state.current === 'title' || state.current === 'gameover' || state.current === 'clear') {
          resetGame()
        }
        return
      }
      if (state.current === 'playing' && onGround.current) {
        velY.current = getDynamicPhysics(speed.current).jumpForce
        onGround.current = false
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resetGame])

  // ---- Game loop ----
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    let raf = 0
    // 60fps を基準 (1フレーム = 1000/60 ms) に正規化したデルタ
    const TARGET_FRAME_MS = 1000 / 60

    const loop = (timestamp: number) => {
      raf = requestAnimationFrame(loop)

      // 初回フレームはスキップして lastTime を初期化
      if (lastTime.current === 0) {
        lastTime.current = timestamp
        return
      }
      // dt=1.0 が 60fps 相当。タブ非表示などの大ジャンプを 3 フレーム分に制限
      const dt = Math.min((timestamp - lastTime.current) / TARGET_FRAME_MS, 3) * TIME_SCALE
      lastTime.current = timestamp

      // --- Update ---
      if (state.current === 'playing') {
        frameCount.current += dt
        score.current = Math.floor(frameCount.current / 6)
        speed.current = INITIAL_SPEED + frameCount.current * SPEED_INCREMENT

        velY.current += getDynamicPhysics(speed.current).gravity * dt
        playerY.current += velY.current * dt
        if (playerY.current >= GROUND_Y - PLAYER_H) {
          playerY.current = GROUND_Y - PLAYER_H
          velY.current = 0
          onGround.current = true
        }

        spawnTimer.current -= dt
        if (spawnTimer.current <= 0) {
          const blocks = 1 + Math.floor(Math.random() * 3)
          obstacles.current.push({ x: CANVAS_W + 10, blocks })
          spawnTimer.current = (MIN_SPAWN_DISTANCE + Math.random() * SPAWN_DISTANCE_RANGE) / speed.current
        }

        obstacles.current = obstacles.current
          .map(o => ({ ...o, x: o.x - speed.current * dt }))
          .filter(o => o.x + BLOCK_SIZE > -10)

        if (triggerClear.current) {
          triggerClear.current = false
          state.current = 'clear'
          if (score.current > highScore.current) highScore.current = score.current
          setUiState('clear')
        }

        for (const o of obstacles.current) {
          const oh = o.blocks * BLOCK_SIZE
          if (
            collides(
              PLAYER_X, playerY.current, PLAYER_W, PLAYER_H,
              o.x, GROUND_Y - oh, BLOCK_SIZE, oh,
            )
          ) {
            state.current = 'gameover'
            if (score.current > highScore.current) highScore.current = score.current
            tauntMessage.current = TAUNT_MESSAGES[Math.floor(Math.random() * TAUNT_MESSAGES.length)]
            setUiState('gameover')
            break
          }
        }
      }

      // --- Draw ---
      // Background
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

      // Ground
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, GROUND_Y)
      ctx.lineTo(CANVAS_W, GROUND_Y)
      ctx.stroke()

      // Scanline effect (subtle horizontal lines)
      ctx.fillStyle = 'rgba(255,255,255,0.03)'
      for (let y = 0; y < CANVAS_H; y += 4) {
        ctx.fillRect(0, y, CANVAS_W, 1)
      }

      // Player
      const isAir = !onGround.current
      drawStickMan(ctx, PLAYER_X, playerY.current, frameCount.current * 0.28, isAir)

      // Obstacles
      for (const o of obstacles.current) {
        drawObstacle(ctx, o)
      }

      // Score (during play)
      if (state.current === 'playing') {
        ctx.fillStyle = '#fff'
        ctx.font = `10px ${PIXEL_FONT}`
        ctx.textAlign = 'right'
        ctx.fillText(`SCORE  ${score.current}`, CANVAS_W - 16, 28)
        ctx.fillText(`HI     ${highScore.current}`, CANVAS_W - 16, 46)
        ctx.textAlign = 'left'
      }

      // Title screen
      if (state.current === 'title') {
        ctx.fillStyle = 'rgba(0,0,0,0.75)'
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

        // Border box
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.strokeRect(120, 120, CANVAS_W - 240, CANVAS_H - 240)

        ctx.fillStyle = '#fff'
        ctx.font = `28px ${PIXEL_FONT}`
        ctx.textAlign = 'center'
        ctx.fillText('JUMP!', CANVAS_W / 2, CANVAS_H / 2 - 30)

        ctx.font = `9px ${PIXEL_FONT}`
        ctx.fillText('-- PRESS SHIFT TO START --', CANVAS_W / 2, CANVAS_H / 2 + 20)
        ctx.textAlign = 'left'
      }

      // Clear screen
      if (state.current === 'clear') {
        ctx.fillStyle = 'rgba(0,0,0,0.85)'
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.strokeRect(80, 80, CANVAS_W - 160, CANVAS_H - 160)

        ctx.fillStyle = '#fff'
        ctx.font = `28px ${PIXEL_FONT}`
        ctx.textAlign = 'center'
        ctx.fillText('CONGRATULATIONS!', CANVAS_W / 2, CANVAS_H / 2 - 60)

        ctx.font = `16px ${PIXEL_FONT}`
        ctx.fillText('発言責任関係のネタは思いつきませんでした', CANVAS_W / 2, CANVAS_H / 2 - 20)

        ctx.font = `10px ${PIXEL_FONT}`
        ctx.fillStyle = '#fff'
        ctx.fillText(`SCORE  ${score.current}`, CANVAS_W / 2, CANVAS_H / 2 + 20)
        ctx.fillText(`BEST   ${highScore.current}`, CANVAS_W / 2, CANVAS_H / 2 + 46)

        ctx.font = `8px ${PIXEL_FONT}`
        ctx.fillStyle = '#aaa'
        ctx.fillText('-- PRESS SHIFT TO RETRY --', CANVAS_W / 2, CANVAS_H / 2 + 88)
        ctx.textAlign = 'left'
      }

      // Game over
      if (state.current === 'gameover') {
        ctx.fillStyle = 'rgba(0,0,0,0.8)'
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.strokeRect(100, 100, CANVAS_W - 200, CANVAS_H - 200)

        ctx.fillStyle = '#fff'
        ctx.font = `22px ${PIXEL_FONT}`
        ctx.textAlign = 'center'
        ctx.fillText('GAME OVER', CANVAS_W / 2, CANVAS_H / 2 - 44)

        ctx.font = `10px ${PIXEL_FONT}`
        ctx.fillText(`SCORE  ${score.current}`, CANVAS_W / 2, CANVAS_H / 2)
        ctx.fillText(`BEST   ${highScore.current}`, CANVAS_W / 2, CANVAS_H / 2 + 26)

        ctx.font = `16px ${PIXEL_FONT}`
        ctx.fillStyle = '#f88'
        ctx.fillText(tauntMessage.current, CANVAS_W / 2, CANVAS_H / 2 + 52)

        ctx.font = `8px ${PIXEL_FONT}`
        ctx.fillStyle = '#aaa'
        ctx.fillText('-- PRESS SHIFT TO RETRY --', CANVAS_W / 2, CANVAS_H / 2 + 80)
        ctx.textAlign = 'left'
      }
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: '#000',
      fontFamily: PIXEL_FONT,
    }}>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{
            border: '3px solid #fff',
            display: 'block',
            imageRendering: 'pixelated',
          }}
          tabIndex={0}
        />
        {uiState === 'playing' && (
          <div style={{
            position: 'absolute',
            top: 3,
            left: 3,
            width: CANVAS_W,
            height: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <span style={{
              color: '#fff',
              fontSize: 20,
              fontFamily: '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif',
              textAlign: 'center',
              letterSpacing: 0,
            }}>
              {STORY_LINES[storyIndex]}
            </span>
          </div>
        )}
      </div>
      <p style={{ color: '#555', marginTop: 16, fontSize: 9, fontFamily: PIXEL_FONT, letterSpacing: 1 }}>
        SHIFT でスタート・SPACE でジャンプ！障害物を避けよう
      </p>
    </div>
  )
}
