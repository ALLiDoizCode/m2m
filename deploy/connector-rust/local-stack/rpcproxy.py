import socket, threading, sys
BIND=(sys.argv[1], int(sys.argv[2])); DST=("127.0.0.1", 8545)
def pipe(a,b):
    try:
        while True:
            d=a.recv(65536)
            if not d: break
            b.sendall(d)
    except Exception: pass
    finally:
        try: b.shutdown(socket.SHUT_WR)
        except Exception: pass
def serve(c):
    try:
        u=socket.create_connection(DST)
    except Exception:
        c.close(); return
    threading.Thread(target=pipe,args=(c,u),daemon=True).start()
    pipe(u,c); c.close(); u.close()
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(BIND); s.listen(64)
print("rpcproxy listening", BIND, flush=True)
while True:
    c,_=s.accept(); threading.Thread(target=serve,args=(c,),daemon=True).start()
