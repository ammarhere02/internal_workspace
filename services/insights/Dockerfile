FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 CONTRACTS_DIR=/app/contracts
WORKDIR /app/services/insights
COPY services/insights/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY services/insights/app ./app
COPY contracts /app/contracts
EXPOSE 8001
CMD ["python", "-m", "app.main"]
