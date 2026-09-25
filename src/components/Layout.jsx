import React, { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useOrders } from '../context/OrderContext'
import { clientCode as codeByName } from '../data/mockData'
import { MapPin, LogOut, Bell, ChevronDown, Menu } from 'lucide-react'

// BUG_001: notifications derive from the live activity feed. A stable per-item
// key (durable id, else time+text) lets us track which the signed-in user has
// already seen, persisted in localStorage so the badge doesn't reset on reload.
const notifKey = (n) => String(n.id ?? `${n.time || ''}|${n.action || ''}`)
const seenStoreKey = (user) => `resolute:notifSeen:${user?.email || user?.name || 'anon'}`
const readSeen = (user) => {
  try { return new Set(JSON.parse(localStorage.getItem(seenStoreKey(user)) || '[]')) }
  catch { return new Set() }
}
const NOTIF_DOT = { new: '#2441E5', delivered: '#16a34a', progress: '#d97706', status: '#00B8D9', user: '#2441E5' }

export default function Layout({ children, navItems, role, roleColor = '#2441E5', lightTheme = true }) {
  const { user, logout } = useAuth()
  const { activityLog = [], orders = [], writeError, clearWriteError } = useOrders() || {}
  const navigate    = useNavigate()
  const location    = useLocation()
  const [collapsed, setCollapsed]       = useState(false)
  const [mobileOpen, setMobileOpen]     = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showNotif, setShowNotif]       = useState(false)
  const [seen, setSeen]                 = useState(() => readSeen(user))

  // Notifications visible to this user. Staff/admin see the whole feed; a client
  // sees only entries about their own orders (mirrors My Orders/RLS scoping).
  const notifications = useMemo(() => {
    const isClient = role === 'client'
    if (!isClient) return activityLog
    const myCode = user?.clientCode
    if (!myCode) return []
    const codeOf = (o) => o.clientCode || codeByName(o.client)
    const myIds = new Set(orders.filter(o => codeOf(o) === myCode).map(o => o.id))
    return activityLog.filter(n => {
      if (n.orderId) return myIds.has(n.orderId)
      const m = String(n.action || '').match(/RTS-\d+/)   // seed entries carry the id only in text
      return m ? myIds.has(m[0]) : false
    })
  }, [activityLog, orders, role, user?.clientCode])

  const unreadCount = notifications.reduce((c, n, i) => c + (seen.has(notifKey(n, i)) ? 0 : 1), 0)

  const openNotif = () => {
    setShowUserMenu(false)
    const next = !showNotif
    setShowNotif(next)
    if (next && unreadCount) {                 // mark everything currently shown as read
      const merged = new Set(seen)
      notifications.forEach((n, i) => merged.add(notifKey(n, i)))
      setSeen(merged)
      try { localStorage.setItem(seenStoreKey(user), JSON.stringify([...merged])) } catch { /* ignore */ }
    }
  }

  const handleLogout = () => { logout(); navigate('/login') }

  // One sidebar treatment for every portal: navy ground, indigo active state,
  // cyan badges. Cyan on navy is 6.2:1, so badges stay legible; cyan is never
  // placed on white anywhere in the app.
  const T = {
    mainBg:      '#F3F5F8',
    sidebarBg:   '#12284C',
    sidebarBdr:  'rgba(255,255,255,0.10)',
    topbarBg:    '#FFFFFF',
    topbarBdr:   '#DDE3EC',
    logo:        '#FFFFFF',
    subtext:     'rgba(255,255,255,0.55)',
    navText:     'rgba(255,255,255,0.72)',
    navActive:   '#FFFFFF',
    navActiveBg: '#2441E5',
    navHoverBg:  'rgba(255,255,255,0.08)',
    navBadgeBg:  'rgba(0,184,217,0.22)',
    badgeText:   '#7FDCEC',
    userText:    '#FFFFFF',
    userSub:     'rgba(255,255,255,0.55)',
    logoutClr:   'rgba(255,255,255,0.65)',
    logoutHover: '#FFFFFF',
    iconBg:      '#EDF0F5',
    iconBdr:     '#DDE3EC',
    iconClr:     '#3D5171',
    iconHover:   '#12284C',
    menuBg:      '#FFFFFF',
    menuBdr:     '#DDE3EC',
    menuText:    '#3D5171',
    menuHover:   '#EDF0F5',
    badgePing:   '#00B8D9',
    overlay:     'rgba(12,29,56,0.55)',
  }

  const Sidebar = ({ mobile = false }) => (
    <div className={`flex flex-col h-full transition-all duration-300 ${mobile ? 'w-72' : collapsed ? 'w-[72px]' : 'w-60'}`}
      style={{ background: T.sidebarBg }}>
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b" style={{ borderColor: T.sidebarBdr }}>
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: '#2441E5' }}>
          <MapPin className="w-4 h-4" style={{ color: '#FFFFFF' }} />
        </div>
        {(!collapsed || mobile) && (
          <div className="overflow-hidden min-w-0">
            <div className="font-bold text-sm leading-tight" style={{ color: T.logo }}>Resolute</div>
            <div className="text-xs capitalize" style={{ color: T.subtext }}>{role} Portal</div>
          </div>
        )}
        {!mobile && (
          <button onClick={() => setCollapsed(!collapsed)}
            className="ml-auto flex-shrink-0 transition-colors"
            style={{ color: T.subtext }}
            onMouseOver={e => e.currentTarget.style.color = T.logo}
            onMouseOut={e => e.currentTarget.style.color = T.subtext}>
            <Menu className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Role badge */}
      {(!collapsed || mobile) && (
        <div className="px-4 py-3">
          <span className="text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-lg"
            style={{ background: `${roleColor}20`, color: roleColor, border: `1px solid ${roleColor}30` }}>
            {role}
          </span>
        </div>
      )}

      {/* Nav items */}
      <nav className="flex-1 px-2.5 py-1 space-y-0.5 overflow-y-auto">
        {navItems.map(item => {
          const Icon   = item.icon
          // The portal root ('/admin', '/screener', …) is a prefix of every
          // sub-route, so a plain startsWith lit it up alongside the real page.
          // Root items match exactly; only deeper items match by prefix.
          const isRoot = item.path.split('/').filter(Boolean).length === 1
          const active = location.pathname === item.path
            || (!isRoot && location.pathname.startsWith(item.path + '/'))
          return (
            <button key={item.path}
              onClick={() => { navigate(item.path); setMobileOpen(false) }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 text-sm font-medium"
              style={{
                color:      active ? T.navActive : T.navText,
                background: active ? T.navActiveBg : 'transparent',
                borderLeft: active ? `3px solid ${roleColor}` : '3px solid transparent',
              }}
              onMouseOver={e => { if (!active) e.currentTarget.style.background = T.navHoverBg }}
              onMouseOut={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
            >
              <Icon className="w-4 h-4 flex-shrink-0" style={{ color: active ? roleColor : 'inherit' }} />
              {(!collapsed || mobile) && <span>{item.label}</span>}
              {(!collapsed || mobile) && item.badge && (
                <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full font-bold"
                  style={{ background: T.navBadgeBg, color: T.badgeText }}>
                  {item.badge}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* User footer */}
      <div className="p-3 border-t" style={{ borderColor: T.sidebarBdr }}>
        <button onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors"
          style={{ color: T.logoutClr }}
          onMouseOver={e => e.currentTarget.style.color = T.logoutHover}
          onMouseOut={e => e.currentTarget.style.color = T.logoutClr}>
          <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold flex-shrink-0"
            style={{ background: `${roleColor}35`, color: roleColor }}>
            {user?.avatar}
          </div>
          {(!collapsed || mobile) && (
            <div className="flex-1 text-left overflow-hidden">
              <div className="text-sm font-medium truncate" style={{ color: T.userText }}>{user?.name}</div>
              <div className="text-xs flex items-center gap-1" style={{ color: T.userSub }}>
                <LogOut className="w-3 h-3" /> Sign out
              </div>
            </div>
          )}
        </button>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: T.mainBg }}>
      {/* Desktop sidebar */}
      <div className="hidden md:flex flex-shrink-0 flex-col border-r"
        style={{
          borderColor: T.sidebarBdr,
          background: T.sidebarBg,
          backdropFilter: lightTheme ? 'none' : 'blur(20px)',
          WebkitBackdropFilter: lightTheme ? 'none' : 'blur(20px)',
        }}>
        <Sidebar />
      </div>

      {/* Mobile overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 md:hidden" style={{ background: T.overlay }}
              onClick={() => setMobileOpen(false)} />
            <motion.div initial={{ x: -290 }} animate={{ x: 0 }} exit={{ x: -290 }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="fixed left-0 top-0 bottom-0 z-50 border-r md:hidden"
              style={{ borderColor: T.sidebarBdr }}>
              <Sidebar mobile />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <header className="border-b flex items-center gap-3 px-4 md:px-6 py-3 flex-shrink-0"
          style={{
            background: T.topbarBg,
            borderColor: T.topbarBdr,
            backdropFilter: lightTheme ? 'none' : 'blur(20px)',
            WebkitBackdropFilter: lightTheme ? 'none' : 'blur(20px)',
          }}>
          <button className="md:hidden transition-colors" style={{ color: T.navText }}
            onClick={() => setMobileOpen(true)}>
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex-1" />

          {/* Bell */}
          <div className="relative">
            <button onClick={openNotif}
              className="w-9 h-9 rounded-xl border flex items-center justify-center transition-colors"
              style={{ background: T.iconBg, borderColor: T.iconBdr, color: showNotif ? T.iconHover : T.iconClr }}
              onMouseOver={e => e.currentTarget.style.color = T.iconHover}
              onMouseOut={e => e.currentTarget.style.color = showNotif ? T.iconHover : T.iconClr}
              aria-label="Notifications">
              <Bell className="w-4 h-4" />
            </button>
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
                style={{ background: T.badgePing, color: '#FFFFFF' }}>{unreadCount > 9 ? '9+' : unreadCount}</span>
            )}
            <AnimatePresence>
              {showNotif && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowNotif(false)} />
                  <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
                    className="absolute right-0 top-full mt-2 z-50 rounded-xl border shadow-lg overflow-hidden"
                    style={{ width: 340, maxWidth: '90vw', background: T.menuBg, borderColor: T.menuBdr }}>
                    <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: T.menuBdr }}>
                      <span className="text-sm font-semibold" style={{ color: T.userText }}>Notifications</span>
                      <span className="text-[11px]" style={{ color: T.userSub }}>{notifications.length} recent</span>
                    </div>
                    <div className="max-h-80 overflow-y-auto">
                      {notifications.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
                          <Bell className="w-6 h-6" style={{ color: T.userSub, opacity: 0.6 }} />
                          <span className="text-sm" style={{ color: T.userSub }}>You're all caught up</span>
                        </div>
                      ) : notifications.slice(0, 30).map((n, i) => (
                        <div key={notifKey(n, i)} className="flex gap-2.5 px-4 py-3 border-b last:border-b-0"
                          style={{ borderColor: T.menuBdr }}>
                          <span className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
                            style={{ background: NOTIF_DOT[n.type] || T.userSub }} />
                          <div className="min-w-0">
                            <p className="text-[13px] leading-snug" style={{ color: T.menuText }}>{n.action}</p>
                            {n.time && <p className="text-[11px] mt-0.5" style={{ color: T.userSub }}>{n.time}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          {/* User menu */}
          <div className="relative">
            <button onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 rounded-xl border px-3 py-2 transition-colors"
              style={{ background: T.iconBg, borderColor: T.iconBdr }}>
              <div className="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-bold"
                style={{ background: `${roleColor}35`, color: roleColor }}>
                {user?.avatar}
              </div>
              <span className="hidden sm:block text-sm font-medium" style={{ color: T.userText }}>{user?.name}</span>
              <ChevronDown className="w-3 h-3" style={{ color: T.iconClr }} />
            </button>
            <AnimatePresence>
              {showUserMenu && (
                <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
                  className="absolute right-0 top-full mt-2 w-48 p-1 z-50 rounded-xl border shadow-lg"
                  style={{ background: T.menuBg, borderColor: T.menuBdr }}>
                  <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors"
                    style={{ color: T.menuText }}
                    onMouseOver={e => e.currentTarget.style.background = T.menuHover}
                    onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                    onClick={handleLogout}>
                    <LogOut className="w-4 h-4" /> Sign out
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {/* A refused write must not look like a successful one. RLS filters an
              update to zero rows and PostgREST answers 200, so completing a
              stage on an order that is no longer on your desk left the
              optimistic move on screen and dropped the work. This lives in the
              shell rather than the order page because the same action navigates
              back to the queue — on the order page the warning unmounted before
              anyone could read it. */}
          {writeError && (
            <div className="rounded-xl px-4 py-3 mb-4 text-sm font-medium flex items-start justify-between gap-3"
              style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.28)', color: '#dc2626' }}>
              <span>Not saved — {writeError}. Reload before continuing; what you last saw may not have been recorded.</span>
              <button onClick={clearWriteError} aria-label="Dismiss"
                style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontWeight: 700 }}>×</button>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  )
}
