import { createBrowserRouter } from 'react-router-dom';
import Root from './Root';
import Orders from './Orders';
import OrderDetail from './OrderDetail';
import Settings from './Settings';

const BASE = '/legacy';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Root />,
    children: [
      { index: true, element: <Orders /> },
      { path: 'orders', element: <Orders /> },
      { path: 'orders/:orderId', element: <OrderDetail /> },
      { path: 'settings', element: <Settings /> },
      { path: BASE, element: <Settings /> },
    ],
  },
]);
