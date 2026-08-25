/**
 * 画多边形模块（js/modules/drawPolygon.js）
 * 多顶点闭合面：左键点击加点 → 鼠标移动预览虚线 → 双击结束闭合。
 * 与 drawRect（对角点模型）分离：多边形直接以顶点数组为数据，编辑可独立拖拽每个顶点。
 * 通过 ctx（Draw 实例）调用公共工具方法。
 *
 * 避坑说明（与既有模块一致）：
 * - 绘制前先 ctx.stopEditing() 清理遗留 handler
 * - 预览虚线 hierarchy 用自定义回调（tempPoint），不误用 points 数组
 * - 面实体 hierarchy 用 CallbackProperty 引用 points，编辑拖拽自动更新
 * - 双击画第一个点时不结束绘制
 *
 * @param {object} ctx - Draw 实例（this）
 * @param {object} options - 画多边形参数
 * @param {string} [options.id] - 自定义实体 id（可选，不传则由 Cesium 自动生成）
 * @param {Array} [options.data] - 初始顶点坐标（[[lon, lat], ...]），空数组表示交互绘制
 * @param {object} [options.style] - 样式（lineWidth / color / pointSize）
 * @param {Function} [options.success] - 绘制完成回调，返回 { id, positions, type }
 */
export default function drawPolygon(
  ctx,
  { id, data = [], style = {}, success },
) {
  // 避坑：开始新绘制前，退出可能存在的编辑状态并销毁遗留 handler
  ctx.stopEditing();

  const shape = {
    type: "polygon",
    id, // 用户自定义实体 id（可选）
    points: [...data], // 顶点数组 [[lon, lat], ...]
    tempPoint: null, // 跟随鼠标的临时虚线端点
    mainEntity: null, // 面实体（polygon）
    tempEntity: null, // 临时虚线实体
    pointsEntity: [], // 顶点实体（编辑拖拽用）
    success, // 完成回调
    style: {
      lineWidth: style.lineWidth ?? ctx.config.lineWidth,
      color: style.color ?? ctx.config.color,
      pointSize: style.pointSize ?? ctx.config.pointSize,
    },
    firstPointTime: null, // 第一个点的点击时间（识别"双击画第一个点"）
  };
  ctx.activeShape = shape;

  // 避坑：传了 id 且已存在时，先移除旧实体（含 shapes 数据），覆盖创建
  if (shape.id && ctx.viewer.entities.getById(shape.id)) {
    console.warn(`实体 id "${shape.id}" 已存在，旧实体将被移除`);
    const oldShape = ctx.shapes.find((s) => s.mainEntity.id === shape.id);
    if (oldShape) {
      ctx.removeShape(oldShape);
    } else {
      ctx.viewer.entities.removeById(shape.id);
    }
  }
  // 主实体：面（hierarchy 引用 points，自动闭合，编辑拖拽自动更新）
  shape.mainEntity = ctx.createPolygonEntity(shape.points, shape.style, {
    id: shape.id,
  });

  // 加点：顶点实体（画线样式：小号、无白边）
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
    // 移除预览虚线和预览面
    ctx.viewer.entities.remove(shape.tempDashEntity);
    shape.tempDashEntity = null;
    ctx.viewer.entities.remove(shape.tempEntity);
    shape.tempEntity = null;
    if (shape.points.length < 3) {
      // 顶点不足，整个面作废
      ctx.viewer.entities.remove(shape.mainEntity);
      shape.pointsEntity.forEach((item) => {
        ctx.viewer.entities.remove(item);
      });
      console.warn("多边形至少需要三个点");
      ctx.activeShape = null;
      ctx.destroy();
      return;
    }
    // 显示正式面（绘制中隐藏，完成时显示）
    shape.mainEntity.show = true;
    ctx.completeShape(shape);
  };
  // 供 drawTool.stopDraw() 调用（预留，停止绘制直接清理，不触发完成）
  shape.finish = finishDraw;

  // 预置坐标数据的场景：直接画好并入库
  if (shape.points.length >= 3) {
    shape.points.forEach(addPoint);
    ctx.completeShape(shape);
    return;
  }

  // 交互绘制中隐藏正式面，只显示预览（避免两个半透明面叠加颜色加深）
  shape.mainEntity.show = false;

  // 预览虚线：最后一点 → 鼠标位置（顶点不足 2 个时只有虚线，可视效果更好）
  // 避坑：positions 用自定义回调，不误用 points 数组
  shape.tempDashEntity = ctx.createPolylineEntity(shape.points, shape.style, {
    dash: true,
    positions: () => {
      if (shape.points.length === 0 || !shape.tempPoint) return [];
      const last = shape.points[shape.points.length - 1];
      return [
        Cesium.Cartesian3.fromDegrees(last[0], last[1]),
        Cesium.Cartesian3.fromDegrees(shape.tempPoint[0], shape.tempPoint[1]),
      ];
    },
  });
  shape.tempDashEntity.show = false;

  // 预览面：跟随鼠标（已画顶点 + 鼠标位置临时闭合），顶点 ≥ 2 时显示面
  shape.tempEntity = ctx.createPolygonEntity([], shape.style, {
    positions: () => {
      if (shape.points.length < 2) return []; // 顶点不足，面退化为虚线预览
      return [
        ...shape.points,
        shape.tempPoint || shape.points[shape.points.length - 1],
      ];
    },
  });
  shape.tempEntity.show = false;

  ctx.handler = new Cesium.ScreenSpaceEventHandler(ctx.viewer.scene.canvas);
  // 监听鼠标移动：更新临时预览 + 显示坐标标签
  ctx.handler.setInputAction((e) => {
    const lonlat = ctx.pickLonLat(e.endPosition);
    if (!lonlat) {
      ctx.removeLabel();
      return; // 如果没有点击到地面，返回
    }
    ctx.addLabel(
      Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1]),
      `单击加点，右击删除，双击结束\n经度：${lonlat[0]}°\n纬度：${lonlat[1]}°`,
    );
    if (shape.points.length > 0) {
      // 临时闭合点（经纬度），虚线 / 预览面回调都会用到
      shape.tempPoint = lonlat;
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // 监听左键点击：记录顶点
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
    shape.points.push(lonlat);
    addPoint(lonlat);
    // 预览：只有 1 个点时显示虚线（连接第一点到鼠标）；≥ 2 个点只显示预览面
    shape.tempDashEntity.show = shape.points.length < 2;
    shape.tempEntity.show = shape.points.length >= 2;
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 监听右键点击：删除最后一个顶点，删除后预览立即重绘
  ctx.handler.setInputAction((e) => {
    if (shape.points.length === 0) return; // 没有点可删
    ctx.viewer.entities.remove(shape.pointsEntity.pop());
    shape.points.pop();
    if (shape.points.length > 0) {
      const lonlat = ctx.pickLonLat(e.position);
      if (lonlat) {
        shape.tempPoint = lonlat;
      }
      // 删到只剩 1 个点时：面退化为虚线；≥ 2 个点只显示面
      shape.tempDashEntity.show = shape.points.length < 2;
      shape.tempEntity.show = shape.points.length >= 2;
    } else {
      // 没有点了，预览消失
      shape.tempDashEntity.show = false;
      shape.tempEntity.show = false;
      shape.tempPoint = null;
    }
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

  // 监听双击，结束绘制
  ctx.handler.setInputAction(() => {
    finishDraw();
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
}
