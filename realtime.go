package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// handleWS — эхо по WebSocket для измерения задержки (в покое и под нагрузкой).
// Текстовое сообщение «u» — счётчик отдачи этого соединения: при первом запросе сервер его
// заводит, ответ «u<id>:<принято байт>»; если счётчиков слишком много — просто «u».
func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(1024)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	var upID string
	var up *atomic.Int64
	defer func() {
		if upID != "" {
			s.uploads.remove(upID)
		}
	}()
	for {
		typ, msg, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageText && string(msg) == "u" {
			if up == nil {
				upID, up = s.uploads.create()
			}
			if up != nil {
				msg = strconv.AppendInt(append(append(msg, upID...), ':'), up.Load(), 10)
			}
		}
		if err := c.Write(ctx, typ, msg); err != nil {
			return
		}
	}
}

// rtcServer — WebRTC-эхо по ненадёжному каналу (UDP без повторов) для измерения потерь пакетов.
// Все соединения обслуживаются одним UDP-портом, сервер работает как ICE-lite.
type rtcServer struct {
	mux      ice.UDPMux
	publicIP string
}

func newRTCServer(port int, publicIP string) (*rtcServer, error) {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: port})
	if err != nil {
		return nil, err
	}
	return &rtcServer{mux: webrtc.NewICEUDPMux(nil, conn), publicIP: publicIP}, nil
}

// candidateIPs — какие адреса сообщить клиенту: RTC_PUBLIC_IP, иначе адрес из заголовка Host
// (контейнер за NAT docker не знает свой внешний адрес, а клиент пришёл именно на Host).
// Host присылает клиент, поэтому адреса из сетей самого сервера (в docker это внутренние
// сети контейнеров) отбрасываются: иначе по имени соседнего контейнера можно узнать его IP.
func (s *rtcServer) candidateIPs(r *http.Request) []string {
	if s.publicIP != "" {
		return []string{s.publicIP}
	}
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	if !validHost(host) {
		return nil
	}
	var addrs []netip.Addr
	if a, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		addrs = []netip.Addr{a}
	} else {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if addrs, err = net.DefaultResolver.LookupNetIP(ctx, "ip", host); err != nil {
			return nil
		}
	}
	local := localNets()
	var out []string
next:
	for _, a := range addrs {
		a = a.Unmap()
		if a.IsLoopback() || a.IsUnspecified() || a.IsMulticast() {
			continue
		}
		for _, p := range local {
			if p.Contains(a) {
				continue next
			}
		}
		out = append(out, a.String())
	}
	return out
}

// localNets — сети, к которым сервер подключён напрямую.
func localNets() []netip.Prefix {
	ifaddrs, _ := net.InterfaceAddrs()
	var out []netip.Prefix
	for _, ia := range ifaddrs {
		if n, ok := ia.(*net.IPNet); ok {
			if p, err := netip.ParsePrefix(n.String()); err == nil && !p.Addr().IsLoopback() {
				out = append(out, p.Masked())
			}
		}
	}
	return out
}

func (s *server) handleRTC(w http.ResponseWriter, r *http.Request) {
	if s.rtc == nil {
		http.Error(w, "udp test disabled", http.StatusServiceUnavailable)
		return
	}
	var offer webrtc.SessionDescription
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&offer); err != nil {
		http.Error(w, "bad offer", http.StatusBadRequest)
		return
	}
	// место в лимите занято, пока живёт соединение, а не только на время запроса
	ip := s.clientIP(r)
	if !s.peers.acquire(ip) {
		tooMany(w)
		return
	}
	var pc *webrtc.PeerConnection
	var once sync.Once
	closePC := func() {
		once.Do(func() {
			if pc != nil {
				pc.Close()
			}
			s.peers.release(ip)
		})
	}

	var se webrtc.SettingEngine
	se.SetLite(true)
	se.SetICEUDPMux(s.rtc.mux)
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled) // серверу не нужен, лишний разбор чужих пакетов
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	if ips := s.rtc.candidateIPs(r); len(ips) > 0 {
		se.SetNAT1To1IPs(ips, webrtc.ICECandidateTypeHost)
	} else {
		se.SetIncludeLoopbackCandidate(true)
	}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		closePC()
		log.Printf("webrtc: %v", err)
		http.Error(w, "webrtc unavailable", http.StatusInternalServerError)
		return
	}
	// Тест длится пару секунд; страхуемся от брошенных соединений. Не установленное за 15 с
	// закрываем раньше: иначе пустые запросы надолго занимают общий лимит.
	time.AfterFunc(60*time.Second, closePC)
	time.AfterFunc(15*time.Second, func() {
		if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			closePC()
		}
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		switch st {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateDisconnected, webrtc.PeerConnectionStateClosed:
			go closePC() // не из обработчика pion: Close ждёт завершения его горутин
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnMessage(func(m webrtc.DataChannelMessage) { dc.Send(m.Data) })
	})

	fail := func(err error) {
		closePC()
		log.Printf("webrtc: %v", err)
		http.Error(w, "webrtc negotiation failed", http.StatusBadRequest)
	}
	if err := pc.SetRemoteDescription(offer); err != nil {
		fail(err)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		fail(err)
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		fail(err)
		return
	}
	<-gathered
	writeJSON(w, pc.LocalDescription())
}
