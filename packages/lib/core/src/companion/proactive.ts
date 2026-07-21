/*
 * 优先级：
 * 1. 聊到一半消失 15～30 分钟，由模型判断是否追问；
 * 2. 早餐、午饭、晚饭和 23:00 晚安；
 * 3. 普通的上下文主动互动。
 *
 * 未完成话题追问不受普通 20 分钟间隔限制。
 */
if (unfinishedDue) {
  trigger = 'unfinished_follow_up';
} else if (
  !isWithinMinimumGap
  && routineTrigger
  && routineIdleEnough
) {
  trigger = routineTrigger;
} else if (
  !isWithinMinimumGap
  && now >= state.nextSendAt
) {
  trigger = 'context_follow_up';
}