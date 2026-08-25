/**
 * 画线模块（js/modules/drawLine.js）
 * 独立的画线交互逻辑，通过 ctx（Draw 实例）调用公共工具方法，
 * 避免 drawTool.js 代码杂乱；后续画点 / 画面可参照本模块拆分。
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画线参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {Array} [options.data] - 初始坐标点（[[lon, lat], ...]），空数组表示交互绘制
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
 * @param {Function} [options.success] - 绘制完成回调，返回该线坐标点数组
 */
export default function drawLine(ctx, { id, data = [], style = {}, success }) {
  // 开始新绘制前，退出可能存在的编辑状态并销毁遗留 handler
  ctx.stopEditing();

  const shape = {
    type: "line",
    id, // 用户自定义实体 id（可选）
    points: [...data],
    tempPoint: null, // 跟随鼠标的临时虚线端点
    mainEntity: null, // 线实体
    tempEntity: null, // 临时虚线实体
    pointsEntity: [], // 点实体数组（与 points 一一对应）
    success, // 完成回调
    style: {
      lineWidth: style.lineWidth ?? ctx.config.lineWidth,
      color: style.color ?? ctx.config.color,
      pointSize: style.pointSize ?? ctx.config.pointSize,
    },
    firstPointTime: null, // 第一个点的点击时间（识别"双击画第一个点"）
  };
  ctx.activeShape = shape;

  // 主实体：实线（传了 id 则指定实体 id，不传由 Cesium 自动生成）
  if (shape.id && ctx.viewer.entities.getById(shape.id)) {
    // id 已存在：移除旧实体（含本工具 shapes 中的残留数据），避免创建冲突（覆盖旧实体）
    console.warn(`实体 id "${shape.id}" 已存在，旧实体将被移除`);
    const oldShape = ctx.shapes.find((s) => s.mainEntity.id === shape.id);
    if (oldShape) {
      ctx.removeShape(oldShape);
    } else {
      ctx.viewer.entities.removeById(shape.id);
    }
  }
  shape.mainEntity = ctx.createPolylineEntity(shape.points, shape.style, {
    id: shape.id,
  });

  // 加点：画线过程中的点（小号、无描边）
  const addPoint = (lonlat) => {
    const entity = ctx.createPointEntity(lonlat, {
      size: Math.max(shape.style.pointSize - 4, 4),
      color: shape.style.color,
      outline: false,
    });
    shape.pointsEntity.push(entity);
    return entity;
  };

  // 完成绘制
  const finishDraw = () => {
    // 一个点都还没画时，双击不退出绘制（忽略本次双击，继续画）
    if (shape.points.length === 0) return;
    // 双击画第一个点：第一个点刚画（500ms 内）就触发双击，
    // 回退双击多加的点，只保留第一个点，不退出绘制
    if (
      shape.firstPointTime &&
      Date.now() - shape.firstPointTime < 500 &&
      shape.points.length <= 2
    ) {
      while (shape.points.length > 1) {
        ctx.viewer.entities.remove(shape.pointsEntity.pop());
        shape.points.pop();
      }
      shape.firstPointTime = null;
      return;
    }
    shape.firstPointTime = null;
    // 移除临时虚线
    ctx.viewer.entities.remove(shape.tempEntity);
    shape.tempEntity = null;
    if (shape.points.length < 2) {
      // 点数不足，整条线作废
      ctx.viewer.entities.remove(shape.mainEntity);
      shape.pointsEntity.forEach((item) => {
        ctx.viewer.entities.remove(item);
      });
      console.warn("请至少选择两个点");
      ctx.activeShape = null;
      ctx.destroy();
      return;
    }
    ctx.completeShape(shape);
  };
  // 供 drawTool.stopDraw() 调用（预留，停止绘制直接清理，不触发完成）
  shape.finish = finishDraw;

  // 预置坐标数据的场景：直接画好并入库，画完马上进入编辑
  if (shape.points.length > 1) {
    shape.points.forEach(addPoint);
    ctx.completeShape(shape);
    return;
  }

  // 临时虚线，跟随鼠标移动（positions 返回最后一个点到鼠标位置的 tempPoint）
  shape.tempEntity = ctx.createPolylineEntity(shape.points, shape.style, {
    dash: true,
    positions: () => shape.tempPoint,
  });

  ctx.handler = new Cesium.ScreenSpaceEventHandler(ctx.viewer.scene.canvas);
  // 监听鼠标移动，动态更新临时虚线 + 显示经纬度标签
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      ctx.removeLabel();
      return; // 如果没有点击到地面，返回
    }
    ctx.addLabel(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `单击新增，右击删除，双击结束\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
    // 更新跟随鼠标的临时虚线（只要鼠标移动时）
    if (shape.points.length > 0) {
      const last = shape.points[shape.points.length - 1];
      shape.tempPoint = [
        Cesium.Cartesian3.fromDegrees(last[0], last[1]),
        Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      ];
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  // 监听左键点击，记录坐标并绘制线段
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.position);
    if (!lonlat) return; // 如果没有点击到地面，返回
    if (shape.points.length > 0) {
      const last = shape.points[shape.points.length - 1];
      if (last[0] === lonlat[0] && last[1] === lonlat[1]) return;
    }
    // 记录第一个点的点击时间，用于识别"双击画第一个点"场景
    if (shape.points.length === 0) {
      shape.firstPointTime = Date.now();
    }
    shape.points.push(lonlat); // 保存坐标
    addPoint(lonlat);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 监听右键点击：删除最后一个点，删除后虚线立即重绘
  ctx.handler.setInputAction((e) => {
    if (shape.points.length === 0) return; // 没有点可删
    ctx.viewer.entities.remove(shape.pointsEntity.pop());
    shape.points.pop();
    if (shape.points.length > 0) {
      // 从新的最后一个点连接到当前鼠标位置
      const lonlat = ctx.pickLonLat(e.position);
      if (lonlat) {
        const last = shape.points[shape.points.length - 1];
        shape.tempPoint = [
          Cesium.Cartesian3.fromDegrees(last[0], last[1]),
          Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
        ];
      }
    } else {
      // 没有点了，虚线消失
      shape.tempPoint = [];
    }
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

  // 监听双击，结束绘制
  ctx.handler.setInputAction(() => {
    finishDraw();
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
}
