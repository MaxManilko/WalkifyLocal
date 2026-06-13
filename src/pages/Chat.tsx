import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Container,
  Row,
  Col,
  Card,
  ListGroup,
  Form,
  Button,
  Spinner,
  Alert,
} from "react-bootstrap";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getUserProfile, searchUsers, type UserProfile } from "../services/supabaseService";
import {
  getConversations,
  getOrCreateConversation,
  getMessages,
  sendMessage,
  subscribeToMessages,
  unsubscribeFromChannel,
  blockUser,
  unblockUser,
  isUserBlockedByMe,
  areUsersBlocked,
  type ConversationWithOtherUser,
  type Message,
} from "../services/chatService";
import { RealtimeChannel } from "@supabase/supabase-js";
import userAvatar from "../assets/images/user.png";
import MapPreview from "../Components/MapPreview";

interface SharedRoutePreview {
  id: string;
  name: string;
  description?: string;
  distance_km?: number;
  points?: [number, number][];
  is_public?: boolean;
}

interface RouteShareMessagePayload {
  type: "route_share";
  route: SharedRoutePreview;
  text?: string | null;
}

function Chat() {
  const { user, profile, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { conversationId: routeConvId } = useParams<{ conversationId?: string }>();
  const [searchParams] = useSearchParams();
  const withUserId = searchParams.get("with");
  const hasSharedRouteFlag = searchParams.get("shareRoute");

  const [conversations, setConversations] = useState<ConversationWithOtherUser[]>([]);
  const [activeConversation, setActiveConversation] = useState<ConversationWithOtherUser | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const containerRef = useRef<HTMLDivElement>(null); 
  
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("default");
  const [sharedRoute, setSharedRoute] = useState<SharedRoutePreview | null>(null);
  const [isBlockedByMe, setIsBlockedByMe] = useState(false);
  const [isChatBlocked, setIsChatBlocked] = useState(false);
  const [blockLoading, setBlockLoading] = useState(false);
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [userSearchResults, setUserSearchResults] = useState<UserProfile[]>([]);
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  
  // Початкова висота
  const [chatHeight, setChatHeight] = useState("100%");

  // Розумний підрахунок висоти екрану (враховуючи мобільну навігацію)
  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        // Визначаємо відступ зверху (шапка додатку)
        const topOffset = Math.max(containerRef.current.getBoundingClientRect().top, 0);
        
        // Визначаємо висоту нижньої навігації (якщо вона є)
        let bottomOffset = 0;
        const navElements = document.querySelectorAll('nav, .bottom-nav, .fixed-bottom');
        
        navElements.forEach(nav => {
          const rect = nav.getBoundingClientRect();
          // Якщо елемент знаходиться в самому низу вікна - це наша навігація
          if (rect.bottom >= window.innerHeight - 10 && rect.top > window.innerHeight / 2) {
            bottomOffset = rect.height;
          }
        });

        // Реальна висота вікна (виправляє баг 100vh на Safari/Chrome mobile)
        const realWindowHeight = window.innerHeight;
        
        // Точна висота чату = весь екран мінус шапка мінус нижня навігація
        const exactHeight = realWindowHeight - topOffset - bottomOffset;
        setChatHeight(`${exactHeight}px`);
      }
    };

    updateHeight();
    const timeoutId1 = setTimeout(updateHeight, 100);
    const timeoutId2 = setTimeout(updateHeight, 500);

    window.addEventListener("resize", updateHeight);
    return () => {
      window.removeEventListener("resize", updateHeight);
      clearTimeout(timeoutId1);
      clearTimeout(timeoutId2);
    };
  }, [authLoading]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof Notification === "undefined") {
      setNotificationPermission("unsupported");
      return;
    }
    setNotificationPermission(Notification.permission);
  }, []);

  useEffect(() => {
    if (!hasSharedRouteFlag) return;
    try {
      const stored = localStorage.getItem("routeToShare");
      if (stored) {
        const parsed = JSON.parse(stored) as SharedRoutePreview;
        setSharedRoute(parsed);
        if (!newMessage) {
          setNewMessage(`I want to share a walking route with you: "${parsed.name}".`);
        }
      }
    } catch (err) {
      console.error("Error loading shared route:", err);
      setSharedRoute(null);
    }
  }, [hasSharedRouteFlag, newMessage]);

  const handleEnableNotifications = async () => {
    if (typeof Notification === "undefined") return;
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
    } catch (err) {
      console.error("Notification permission error:", err);
    }
  };

  const loadConversations = useCallback(async (): Promise<ConversationWithOtherUser[]> => {
    if (!user) return [];
    try {
      const convs = await getConversations();
      setConversations(convs);
      return convs;
    } catch (err: any) {
      setError(err.message || "Failed to load conversations");
      return [];
    }
  }, [user]);

  const updateConversationsWithMessage = useCallback(
    (conversationId: string, msg: Message) => {
      setConversations((prev) => {
        if (!prev || prev.length === 0) return prev;
        const updated = prev.map((c) =>
          c.id === conversationId ? { ...c, last_message: msg } : c
        );
        const index = updated.findIndex((c) => c.id === conversationId);
        if (index > 0) {
          const conv = updated[index];
          const rest = [...updated];
          rest.splice(index, 1);
          return [conv, ...rest];
        }
        return updated;
      });
    },
    []
  );

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      navigate("/login");
      return;
    }

    const init = async () => {
      setLoading(true);
      setError(null);

      try {
        const convs = await loadConversations();

        if (withUserId) {
          const conv = await getOrCreateConversation(withUserId);
          const otherProfile = await getUserProfile(withUserId);
          setActiveConversation({
            ...conv,
            other_user: otherProfile || undefined,
          });
          const refreshed = await loadConversations();
          setConversations(refreshed);
          navigate(`/chat/${conv.id}`, { replace: true });
        } else if (routeConvId) {
          const matched = convs.find((c) => c.id === routeConvId);
          setActiveConversation(matched || null);
        } else {
          setActiveConversation(null);
        }
      } catch (err: any) {
        setError(err.message || "Something went wrong");
      } finally {
        setLoading(false);
      }
    };

    init();
  }, [user, authLoading, routeConvId, withUserId, loadConversations]);

  useEffect(() => {
    if (!activeConversation) {
      setMessages([]);
      return;
    }

    let mounted = true;

    const setup = async () => {
      try {
        const msgs = await getMessages(activeConversation.id);
        if (mounted) setMessages(msgs);
      } catch (err: any) {
        if (mounted) setError(err.message || "Failed to load messages");
      }

      const channel = subscribeToMessages(activeConversation.id, (msg) => {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        updateConversationsWithMessage(activeConversation.id, msg);
      });
      channelRef.current = channel;
    };

    setup();

    return () => {
      mounted = false;
      if (channelRef.current) {
        unsubscribeFromChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [activeConversation?.id]);

  useEffect(() => {
    const otherId = activeConversation?.other_user?.id;
    if (!otherId || !user) {
      setIsBlockedByMe(false);
      setIsChatBlocked(false);
      return;
    }

    Promise.all([
      isUserBlockedByMe(otherId),
      areUsersBlocked(user.id, otherId),
    ]).then(([byMe, blocked]) => {
      setIsBlockedByMe(byMe);
      setIsChatBlocked(blocked);
    });
  }, [activeConversation?.other_user?.id, user]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSelectConversation = (conv: ConversationWithOtherUser) => {
    setActiveConversation(conv);
    navigate(`/chat/${conv.id}`);
  };

  const handleUserSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = userSearchQuery.trim();
    if (!q) {
      setUserSearchResults([]);
      return;
    }

    setUserSearchLoading(true);
    try {
      const results = await searchUsers(q);
      setUserSearchResults(
        results.filter((profile) => profile.id !== user?.id)
      );
    } catch (err) {
      console.error("User search error:", err);
      setUserSearchResults([]);
    } finally {
      setUserSearchLoading(false);
    }
  };

  const handleStartChatWithUser = async (otherUserId: string) => {
    try {
      setError(null);
      const conv = await getOrCreateConversation(otherUserId);
      const otherProfile = await getUserProfile(otherUserId);
      const withUser: ConversationWithOtherUser = {
        ...conv,
        other_user: otherProfile || undefined,
      };
      setActiveConversation(withUser);
      const refreshed = await loadConversations();
      setConversations(refreshed);
      setUserSearchQuery("");
      setUserSearchResults([]);
      navigate(`/chat/${conv.id}`);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Не вдалося почати чат";
      setError(message);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeConversation || sending) return;
    if (!newMessage.trim() && !sharedRoute) return;

    setSending(true);
    try {
      let contentToSend = newMessage;
      if (sharedRoute) {
        const payload: RouteShareMessagePayload = {
          type: "route_share",
          route: sharedRoute,
          text: newMessage.trim() || null,
        };
        contentToSend = JSON.stringify(payload);
      }

      const msg = await sendMessage(activeConversation.id, contentToSend);
      setMessages((prev) => [...prev, msg]);
      setNewMessage("");
      if (sharedRoute) {
        setSharedRoute(null);
        localStorage.removeItem("routeToShare");
      }
      updateConversationsWithMessage(activeConversation.id, msg);
      scrollToBottom();
    } catch (err: any) {
      setError(err.message || "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const handleToggleBlock = async () => {
    const otherId = activeConversation?.other_user?.id;
    if (!otherId) return;

    const confirmMsg = isBlockedByMe
      ? "Розблокувати цього користувача?"
      : "Заблокувати цього користувача? Ви не зможете обмінюватися повідомленнями.";
    if (!window.confirm(confirmMsg)) return;

    setBlockLoading(true);
    try {
      if (isBlockedByMe) {
        await unblockUser(otherId);
        setIsBlockedByMe(false);
        setIsChatBlocked(false);
      } else {
        await blockUser(otherId);
        setIsBlockedByMe(true);
        setIsChatBlocked(true);
        setActiveConversation(null);
        navigate("/chat");
        await loadConversations();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Помилка блокування";
      setError(message);
    } finally {
      setBlockLoading(false);
    }
  };

  const handleOpenSharedRoute = (route: SharedRoutePreview) => {
    if (route.points && Array.isArray(route.points)) {
      localStorage.setItem(
        "routeToView",
        JSON.stringify({
          name: route.name,
          description: route.description,
          points: route.points,
          distance_km: route.distance_km,
        })
      );
    }
    navigate("/");
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const formatLastMessage = (msg?: Message | null) => {
    if (!msg) return "No messages yet";
    const preview = msg.content.length > 50 ? msg.content.slice(0, 50) + "…" : msg.content;
    return preview;
  };

  if (authLoading) {
    return (
      <Container className="chat-page d-flex align-items-center justify-content-center h-100">
        <div className="text-center py-4">
          <Spinner animation="border" variant="success" />
          <p className="mt-3 mb-0">Loading...</p>
        </div>
      </Container>
    );
  }
  if (!user) {
    return (
      <Container className="chat-page text-center py-4 h-100">
        <Alert variant="warning">Please log in to use chat.</Alert>
        <Button variant="success" onClick={() => navigate("/login")}>
          Log in
        </Button>
      </Container>
    );
  }

  return (
    <Container 
      fluid 
      className="chat-page p-0" 
      ref={containerRef}
      style={{ height: chatHeight, overflow: "hidden" }}
    >
      <Row className="g-0 h-100 chat-layout-row">
        {/* Conversation list (Sidebar) */}
        <Col
          xs={12}
          md={4}
          lg={3}
          className={`border-end bg-light chat-sidebar flex-column h-100 ${
            activeConversation ? "d-none d-md-flex" : "d-flex"
          }`}
        >
          {/* Фіксована шапка сайдбару */}
          <div className="p-3 border-bottom bg-white flex-shrink-0">
            <h5 className="mb-3">
              <i className="bi bi-chat-dots me-2"></i>
              Повідомлення
            </h5>
            <Form onSubmit={handleUserSearch} className="chat-search-form">
              <div className="d-flex gap-2">
                <Form.Control
                  type="search"
                  size="sm"
                  placeholder="Пошук користувачів..."
                  value={userSearchQuery}
                  onChange={(e) => setUserSearchQuery(e.target.value)}
                />
                <Button
                  type="submit"
                  variant="success"
                  size="sm"
                  disabled={userSearchLoading}
                >
                  {userSearchLoading ? (
                    <Spinner animation="border" size="sm" />
                  ) : (
                    <i className="bi bi-search"></i>
                  )}
                </Button>
              </div>
            </Form>
            {userSearchResults.length > 0 && (
              <ListGroup variant="flush" className="chat-search-results mt-2 border rounded">
                {userSearchResults.map((result) => (
                  <ListGroup.Item
                    key={result.id}
                    action
                    className="d-flex align-items-center gap-2 py-2"
                    onClick={() => handleStartChatWithUser(result.id)}
                  >
                    <img
                      src={result.avatar_url || userAvatar}
                      alt=""
                      className="rounded-circle flex-shrink-0"
                      style={{ width: 32, height: 32, objectFit: "cover" }}
                    />
                    <div className="min-width-0">
                      <div className="fw-semibold text-truncate small">
                        {result.full_name || "Користувач"}
                      </div>
                      <small className="text-muted text-truncate d-block">
                        {result.email}
                      </small>
                    </div>
                  </ListGroup.Item>
                ))}
              </ListGroup>
            )}
          </div>

          {/* Список чатів з прокруткою */}
          <div className="flex-grow-1 overflow-y-auto">
            {loading ? (
              <div className="text-center py-5">
                <Spinner animation="border" variant="success" />
                <p className="mt-2 text-muted">Loading conversations...</p>
              </div>
            ) : error ? (
              <Alert variant="danger" className="m-3">
                {error}
              </Alert>
            ) : conversations.length === 0 ? (
              <div className="p-4 text-center text-muted">
                <i className="bi bi-chat fs-1"></i>
                <p className="mt-2 mb-0">No conversations yet</p>
                <small>Search for users and start a chat from their profile</small>
              </div>
            ) : (
              <ListGroup variant="flush">
                {conversations.map((conv) => {
                  const isActive = activeConversation?.id === conv.id;
                  return (
                    <ListGroup.Item
                      key={conv.id}
                      action
                      onClick={() => handleSelectConversation(conv)}
                      className={`d-flex align-items-center py-3 border-0 border-bottom rounded-0 chat-conversation-item ${
                        isActive ? "chat-conversation-item--active" : ""
                      }`}
                    >
                      <img
                        src={conv.other_user?.avatar_url || userAvatar}
                        alt=""
                        className="rounded-circle me-3"
                        style={{ width: 48, height: 48, objectFit: "cover" }}
                      />
                      <div className="flex-grow-1 overflow-hidden">
                        <div className="d-flex justify-content-between align-items-start">
                          <span className="fw-semibold text-truncate">
                            {conv.other_user?.full_name || "Unknown"}
                          </span>
                          {conv.last_message && (
                            <small className="text-muted ms-2 flex-shrink-0">
                              {formatTime(conv.last_message.created_at)}
                            </small>
                          )}
                        </div>
                        <small className="text-muted text-truncate d-block">
                          {formatLastMessage(conv.last_message)}
                        </small>
                      </div>
                    </ListGroup.Item>
                  );
                })}
              </ListGroup>
            )}
          </div>
        </Col>

        {/* Chat area */}
        <Col
          xs={12}
          md={8}
          lg={9}
          className={`bg-white chat-main h-100 flex-column ${
            !activeConversation ? "d-none d-md-flex" : "d-flex"
          }`}
        >
          {activeConversation ? (
            <>
              {/* Фіксована шапка чату */}
              <div className="p-3 border-bottom chat-header flex-shrink-0 d-flex align-items-center justify-content-between">
                <div className="d-flex align-items-center">
                  <Button
                    variant="link"
                    className="d-md-none p-0 text-success flex-shrink-0 me-2"
                    onClick={() => {
                      setActiveConversation(null);
                      navigate("/chat");
                    }}
                    aria-label="Назад до списку"
                  >
                    <i className="bi bi-arrow-left fs-5"></i>
                  </Button>
                  <img
                    src={activeConversation.other_user?.avatar_url || userAvatar}
                    alt=""
                    className="rounded-circle flex-shrink-0 me-3"
                    style={{ width: 40, height: 40, objectFit: "cover" }}
                  />
                  <div className="chat-header-info">
                    <h5 className="mb-0">
                      {activeConversation.other_user?.full_name || "Unknown"}
                    </h5>
                    {isChatBlocked && (
                      <small className="text-muted d-block">
                        {isBlockedByMe
                          ? "Користувача заблоковано"
                          : "Повідомлення недоступні"}
                      </small>
                    )}
                  </div>
                </div>
                
                <div className="chat-header-actions">
                  {activeConversation.other_user?.id && (
                    <Button
                      variant={isBlockedByMe ? "outline-secondary" : "outline-danger"}
                      size="sm"
                      className="me-2"
                      onClick={handleToggleBlock}
                      disabled={blockLoading}
                    >
                      {blockLoading ? (
                        <Spinner animation="border" size="sm" />
                      ) : isBlockedByMe ? (
                        "Розблокувати"
                      ) : (
                        "Заблокувати"
                      )}
                    </Button>
                  )}
                  {notificationPermission === "default" && (
                    <Button
                      variant="outline-success"
                      size="sm"
                      onClick={handleEnableNotifications}
                    >
                      Сповіщення
                    </Button>
                  )}
                </div>
              </div>

              {/* Messages area з прокруткою */}
              <div className="chat-messages p-3 flex-grow-1 overflow-y-auto">
                {messages.map((msg) => {
                  const isOwn = msg.sender_id === user.id;
                  let routeShare: RouteShareMessagePayload | null = null;
                  try {
                    const parsed = JSON.parse(msg.content) as RouteShareMessagePayload;
                    if (parsed && parsed.type === "route_share") {
                      routeShare = parsed;
                    }
                  } catch {
                    routeShare = null;
                  }
                  return (
                    <div
                      key={msg.id}
                      className={`d-flex mb-3 ${isOwn ? "justify-content-end" : "justify-content-start"}`}
                    >
                      <div
                        className={`rounded-3 px-3 py-2 shadow-sm ${
                          isOwn
                            ? "bg-success text-white"
                            : "bg-light text-dark"
                        }`}
                        style={{ maxWidth: "75%" }}
                      >
                        {!isOwn && (
                          <small className="d-block text-muted mb-1">
                            {msg.sender_profile?.full_name || "User"}
                          </small>
                        )}
                        {routeShare ? (
                          <>
                            {routeShare.text && (
                              <p
                                className="mb-2"
                                style={{
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                }}
                              >
                                {routeShare.text}
                              </p>
                            )}
                            <Card
                              className={`border-0 ${
                                isOwn ? "bg-success-subtle" : "bg-light"
                              }`}
                            >
                              {routeShare.route.points && (
                                <MapPreview
                                  points={routeShare.route.points}
                                  isPublic={routeShare.route.is_public}
                                  height={160}
                                />
                              )}
                              <Card.Body className="p-2">
                                <div className="d-flex justify-content-between align-items-center">
                                  <div>
                                    <div className="fw-semibold">
                                      {routeShare.route.name}
                                    </div>
                                    {routeShare.route.distance_km !==
                                      undefined && (
                                      <small className="text-muted">
                                        {(routeShare.route.distance_km || 0).toFixed(
                                          1
                                        )}{" "}
                                        км
                                      </small>
                                    )}
                                  </div>
                                  <Button
                                    variant="outline-success"
                                    size="sm"
                                    onClick={() =>
                                      handleOpenSharedRoute(routeShare!.route)
                                    }
                                  >
                                    <i className="bi bi-map"></i>
                                  </Button>
                                </div>
                              </Card.Body>
                            </Card>
                          </>
                        ) : (
                          <span
                            style={{
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            {msg.content}
                          </span>
                        )}
                        <small
                          className={`d-block mt-1 ${
                            isOwn ? "text-white-50" : "text-muted"
                          }`}
                        >
                          {formatTime(msg.created_at)}
                        </small>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              {/* Message input (фіксований знизу) */}
              {isChatBlocked && !isBlockedByMe && (
                <Alert variant="warning" className="m-3 mb-0 py-2 flex-shrink-0">
                  Цей користувач недоступний для листування.
                </Alert>
              )}
              <Form onSubmit={handleSend} className="p-3 border-top chat-input-area flex-shrink-0">
                {sharedRoute && (
                  <div className="mb-2 p-2 rounded bg-light border d-flex align-items-center">
                    <div className="flex-grow-1">
                      <div className="fw-semibold">
                        Sharing route: {sharedRoute.name}
                      </div>
                      {sharedRoute.distance_km !== undefined && (
                        <small className="text-muted">
                          {(sharedRoute.distance_km || 0).toFixed(1)} км
                        </small>
                      )}
                    </div>
                    <Button
                      variant="outline-danger"
                      size="sm"
                      onClick={() => {
                        setSharedRoute(null);
                        localStorage.removeItem("routeToShare");
                      }}
                    >
                      <i className="bi bi-x"></i>
                    </Button>
                  </div>
                )}
                <div className="d-flex gap-2">
                  <Form.Control
                    type="text"
                    placeholder="Type a message..."
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    disabled={sending || isChatBlocked}
                  />
                  <Button
                    type="submit"
                    variant="success"
                    disabled={
                      sending ||
                      isChatBlocked ||
                      (!newMessage.trim() && !sharedRoute)
                    }
                  >
                    {sending ? (
                      <Spinner animation="border" size="sm" />
                    ) : (
                      <i className="bi bi-send"></i>
                    )}
                  </Button>
                </div>
              </Form>
            </>
          ) : (
            <div className="flex-grow-1 d-flex align-items-center justify-content-center text-muted">
              <div className="text-center">
                <i className="bi bi-chat-left-text display-1"></i>
                <p className="mt-3 mb-0">Select a conversation or start a new chat</p>
                <small>Search for users and click "Message" on their profile</small>
              </div>
            </div>
          )}
        </Col>
      </Row>
    </Container>
  );
}

export default Chat;