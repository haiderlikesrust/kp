import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout.tsx'
import { GameProvider } from './lib/game.tsx'
import { WalletProvider } from './lib/wallet.tsx'
import { GamePage } from './pages/Game.tsx'
import { HistoryPage, RoundPage } from './pages/History.tsx'
import { HowPage } from './pages/How.tsx'
import './index.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <GameProvider>
        <WalletProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<GamePage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="history/:id" element={<RoundPage />} />
              <Route path="how" element={<HowPage />} />
            </Route>
          </Routes>
        </WalletProvider>
      </GameProvider>
    </BrowserRouter>
  </StrictMode>,
)
