package main

import (
	"net/http"
	"net/netip"
	"sync"
)

// ipLimiter ограничивает число одновременных соединений с одного адреса и, по желанию, всего.
// IPv6 считается по сети /64: у одного абонента обычно целая подсеть.
type ipLimiter struct {
	mu       sync.Mutex
	perIP    int // 0 — без ограничения
	maxTotal int // 0 — без ограничения
	total    int
	m        map[netip.Addr]int
}

func newIPLimiter(perIP, maxTotal int) *ipLimiter {
	return &ipLimiter{perIP: perIP, maxTotal: maxTotal, m: map[netip.Addr]int{}}
}

func limitKey(ip netip.Addr) netip.Addr {
	if ip.Is6() {
		if p, err := ip.Prefix(64); err == nil {
			return p.Addr()
		}
	}
	return ip
}

// acquire занимает место; вернёт false, если лимит исчерпан.
func (l *ipLimiter) acquire(ip netip.Addr) bool {
	k := limitKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	if (l.perIP > 0 && l.m[k] >= l.perIP) || (l.maxTotal > 0 && l.total >= l.maxTotal) {
		return false
	}
	l.m[k]++
	l.total++
	return true
}

func (l *ipLimiter) release(ip netip.Addr) {
	k := limitKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.m[k] <= 1 {
		delete(l.m, k)
	} else {
		l.m[k]--
	}
	l.total--
}

func tooMany(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "2")
	http.Error(w, "too many connections from your address", http.StatusTooManyRequests)
}

// limited пропускает запрос, только если у адреса клиента есть свободное место в l.
func (s *server) limited(l *ipLimiter, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := s.clientIP(r)
		if !l.acquire(ip) {
			tooMany(w)
			return
		}
		defer l.release(ip)
		h(w, r)
	}
}
