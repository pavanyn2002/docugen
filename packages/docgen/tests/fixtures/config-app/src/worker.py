import os
QUEUE = os.environ['QUEUE_URL']
LEVEL = os.environ.get('LOG_LEVEL')
TIMEOUT = os.getenv('REQUEST_TIMEOUT')
