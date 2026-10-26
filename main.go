package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

const (
	maxDownload = 1 << 30   // 1 ГБ на один запрос
	maxUpload   = 256 << 20 // 256 МБ на один запрос
)

type config struct {
	Addr           string
	DataDir        string
	ServerName     string
	ServerLocation string
	TrustProxy     bool
	GeoCity        bool
	RTCPort        int
	RTCPublicIP    string
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v, err := strconv.ParseBool(env(key, strconv.FormatBool(def)))
	if err != nil {
		return def
	}
	return v
}

func loadConfig() config {
	port, _ := strconv.Atoi(env("RTC_UDP_PORT", "3479"))
	return config{
		Addr:           env("LISTEN_ADDR", ":8080"),
		DataDir:        env("DATA_DIR", "/data"),
		ServerName:     env("SERVER_NAME", "Speedtest"),
		ServerLocation: env("SERVER_LOCATION", ""),
		TrustProxy:     envBool("TRUST_PROXY", false),
		GeoCity:        envBool("GEOIP_CITY", true),
		RTCPort:        port,
		RTCPublicIP:    env("RTC_PUBLIC_IP", ""),
	}
}

type server struct {
	cfg   config
	geo   *GeoDB
	rtc   *rtcServer
	noise []byte
}

func main() {
	cfg := loadConfig()
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck(cfg.Addr))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s := &server{cfg: cfg, noise: make([]byte, 1<<20)}
	rand.Read(s.noise) // несжимаемые данные для теста загрузки

	s.geo = NewGeoDB(cfg.DataDir, cfg.GeoCity)
	go s.geo.Run(ctx)
	go uploads.cleanup(ctx)

	rtc, err := newRTCServer(cfg.RTCPort, cfg.RTCPublicIP)
	if err != nil {
		log.Printf("webrtc: UDP-тест отключён: %v", err)
	}
	s.rtc = rtc

	static, err := newStatic()
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/info", s.handleInfo)
	mux.HandleFunc("GET /api/download", s.handleDownload)
	mux.HandleFunc("POST /api/upload", s.handleUpload)
	mux.HandleFunc("GET /api/ws", handleWS)
	mux.HandleFunc("POST /api/rtc", s.handleRTC)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok") })
	mux.Handle("GET /", static)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()
	log.Printf("слушаю %s (UDP-тест: порт %d)", cfg.Addr, cfg.RTCPort)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// healthcheck нужен для docker: в distroless-образе нет curl.
func healthcheck(addr string) int {
	_, port, _ := net.SplitHostPort(addr)
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func noStore(w http.ResponseWriter) {
	h := w.Header()
	// no-transform запрещает прокси сжимать или перекодировать ответ
	h.Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0, no-transform")
	h.Set("Pragma", "no-cache")
}

func writeJSON(w http.ResponseWriter, v any) {
	noStore(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

// clientIP возвращает адрес клиента. При TRUST_PROXY=true берётся крайний правый адрес
// из X-Forwarded-For — его дописывает сам прокси, клиент подделать его не может.
func (s *server) clientIP(r *http.Request) netip.Addr {
	if s.cfg.TrustProxy {
		if v := r.Header.Values("X-Forwarded-For"); len(v) > 0 {
			parts := strings.Split(v[len(v)-1], ",")
			if a, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
				return a.Unmap()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	a, _ := netip.ParseAddr(host)
	return a.Unmap()
}

// адреса операторского NAT (RFC 6598): в GeoIP их нет, для посетителя это «локальная сеть»
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

type infoResponse struct {
	IP       string   `json:"ip"`
	Version  int      `json:"version"`
	Private  bool     `json:"private"`
	Geo      *GeoInfo `json:"geo,omitempty"`
	GeoReady bool     `json:"geoReady"`
	Server   struct {
		Name     string `json:"name"`
		Location string `json:"location,omitempty"`
		Time     int64  `json:"time"`
	} `json:"server"`
	UDP bool `json:"udp"`
}

func (s *server) handleInfo(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	resp := infoResponse{IP: ip.String(), Version: 4, GeoReady: s.geo.Ready(), UDP: s.rtc != nil}
	if ip.Is6() {
		resp.Version = 6
	}
	resp.Private = !ip.IsValid() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || cgnat.Contains(ip)
	if !resp.Private {
		resp.Geo = s.geo.Lookup(ip)
	}
	resp.Server.Name = s.cfg.ServerName
	resp.Server.Location = s.cfg.ServerLocation
	resp.Server.Time = time.Now().UnixMilli()
	writeJSON(w, resp)
}

// handleDownload отдаёт size байт несжимаемых данных.
func (s *server) handleDownload(w http.ResponseWriter, r *http.Request) {
	size, _ := strconv.ParseInt(r.URL.Query().Get("size"), 10, 64)
	if size <= 0 {
		size = 25 << 20
	}
	size = min(size, maxDownload)
	noStore(w)
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	for size > 0 {
		n := min(size, int64(len(s.noise)))
		if _, err := w.Write(s.noise[:n]); err != nil {
			return
		}
		size -= n
	}
}

// handleUpload читает тело запроса и выбрасывает его. Если передан id теста,
// принятые байты складываются в его счётчик — страница спрашивает его по WebSocket.
func (s *server) handleUpload(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	var body io.Reader = http.MaxBytesReader(w, r.Body, maxUpload)
	if c := uploads.get(r.URL.Query().Get("id"), true); c != nil {
		body = countingReader{body, &c.n}
	}
	n, _ := io.Copy(io.Discard, body)
	writeJSON(w, map[string]any{"bytes": n, "ms": time.Since(start).Milliseconds()})
}

// ---- счётчики отдачи ----
// Браузер сообщает об отправленных байтах, когда кладёт их в буфер системы, а не когда они
// ушли в сеть: в начале отдачи это даёт ложный всплеск. Поэтому отдачу считает сервер.

type uploadCounter struct {
	n    atomic.Int64 // принято байт
	seen atomic.Int64 // unix-время последнего обращения
}

type uploadRegistry struct {
	mu sync.Mutex
	m  map[string]*uploadCounter
}

var uploads = &uploadRegistry{m: map[string]*uploadCounter{}}

func validTestID(id string) bool {
	if len(id) < 8 || len(id) > 32 {
		return false
	}
	for _, c := range id {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') {
			return false
		}
	}
	return true
}

func (u *uploadRegistry) get(id string, create bool) *uploadCounter {
	if !validTestID(id) {
		return nil
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	c := u.m[id]
	if c == nil && create && len(u.m) < 10000 {
		c = &uploadCounter{}
		u.m[id] = c
	}
	if c != nil {
		c.seen.Store(time.Now().Unix())
	}
	return c
}

// cleanup удаляет счётчики тестов, к которым не обращались больше двух минут.
func (u *uploadRegistry) cleanup(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		old := time.Now().Add(-2 * time.Minute).Unix()
		u.mu.Lock()
		for id, c := range u.m {
			if c.seen.Load() < old {
				delete(u.m, id)
			}
		}
		u.mu.Unlock()
	}
}

type countingReader struct {
	r io.Reader
	n *atomic.Int64
}

func (c countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

// ---- статика: всё держим в памяти, заранее сжато gzip ----

type staticFile struct {
	ctype string
	etag  string
	raw   []byte
	gz    []byte
}

type staticHandler map[string]*staticFile

func newStatic() (staticHandler, error) {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		return nil, err
	}
	files := staticHandler{}
	err = fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		raw, err := fs.ReadFile(sub, p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(raw)
		f := &staticFile{
			ctype: mime.TypeByExtension(path.Ext(p)),
			etag:  `"` + hex.EncodeToString(sum[:8]) + `"`,
			raw:   raw,
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		zw.Write(raw)
		zw.Close()
		if buf.Len() < len(raw) {
			f.gz = buf.Bytes()
		}
		files["/"+p] = f
		return nil
	})
	return files, err
}

func (h staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if p == "/" {
		p = "/index.html"
	}
	f, ok := h[p]
	if !ok {
		http.NotFound(w, r)
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", f.ctype)
	hd.Set("ETag", f.etag)
	hd.Set("Cache-Control", "no-cache")
	hd.Set("Vary", "Accept-Encoding")
	hd.Set("X-Content-Type-Options", "nosniff")
	if r.Header.Get("If-None-Match") == f.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	body := f.raw
	if f.gz != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		hd.Set("Content-Encoding", "gzip")
		body = f.gz
	}
	hd.Set("Content-Length", strconv.Itoa(len(body)))
	w.Write(body)
}
