package main

import (
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
)

// ipLimiter ограничивает число одновременных соединений с одного адреса и, по желанию, всего.
// IPv6 считается по сети /64 (у абонента обычно целая подсеть) и дополнительно по /48
// с вчетверо большим лимитом: иначе владелец крупной подсети обходит ограничение.
type ipLimiter struct {
	mu       sync.Mutex
	perIP    int // 0 — без ограничения
	maxTotal int // 0 — без ограничения
	total    int
	m        map[netip.Prefix]int
}

func newIPLimiter(perIP, maxTotal int) *ipLimiter {
	return &ipLimiter{perIP: perIP, maxTotal: maxTotal, m: map[netip.Prefix]int{}}
}

type limitKey struct {
	p   netip.Prefix
	max int
}

func (l *ipLimiter) keys(ip netip.Addr) []limitKey {
	if ip.Is6() {
		p64, _ := ip.Prefix(64)
		p48, _ := ip.Prefix(48)
		return []limitKey{{p64, l.perIP}, {p48, l.perIP * 4}}
	}
	p, _ := ip.Prefix(ip.BitLen()) // для нераспознанного адреса — общий пустой ключ
	return []limitKey{{p, l.perIP}}
}

// acquire занимает место; вернёт false, если лимит исчерпан.
func (l *ipLimiter) acquire(ip netip.Addr) bool {
	keys := l.keys(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.maxTotal > 0 && l.total >= l.maxTotal {
		return false
	}
	for _, k := range keys {
		if k.max > 0 && l.m[k.p] >= k.max {
			return false
		}
	}
	for _, k := range keys {
		l.m[k.p]++
	}
	l.total++
	return true
}

func (l *ipLimiter) release(ip netip.Addr) {
	keys := l.keys(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		if l.m[k.p] <= 1 {
			delete(l.m, k.p)
		} else {
			l.m[k.p]--
		}
	}
	l.total--
}

func tooMany(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "2")
	http.Error(w, "too many connections", http.StatusTooManyRequests)
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

// crossSite сообщает, что запрос пришёл с чужой страницы. Браузер по HTTPS сам помечает
// такие запросы заголовком Sec-Fetch-Site; без него сверяем Origin и Referer с Host.
func crossSite(r *http.Request) bool {
	if v := r.Header.Get("Sec-Fetch-Site"); v != "" {
		return v != "same-origin" && v != "none"
	}
	for _, h := range []string{"Origin", "Referer"} {
		if v := r.Header.Get(h); v != "" {
			u, err := url.Parse(v)
			return err != nil || !strings.EqualFold(u.Host, r.Host)
		}
	}
	return false
}

// sameOrigin не даёт чужим сайтам расходовать трафик сервера руками своих посетителей.
func sameOrigin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if crossSite(r) {
			http.Error(w, "cross-site requests are not allowed", http.StatusForbidden)
			return
		}
		h(w, r)
	}
}
