FROM python:3.12-slim

RUN pip install --no-cache-dir pymysql

WORKDIR /app
COPY login_server.py .

CMD ["python", "-u", "login_server.py"]
