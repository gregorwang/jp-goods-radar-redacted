package com.jpgr.push.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow
import org.json.JSONObject

/**
 * 收到过的推送。id 就是 push-relay 的消息编号，重连补发时按它去重。
 * openedAt：点开过这一次推送的清单（或点了通知进来）的时间；null 就是没看过。
 */
@Entity(tableName = "messages")
data class MessageEntity(
    @PrimaryKey val id: Long,
    val eventKey: String,
    val kind: String,
    val profileName: String,
    val createdAt: Long,
    val total: Int,
    val firstImage: String?,
    val json: String,
    val receivedAt: Long,
    val openedAt: Long? = null,
) {
    fun message(): PushMessage = parsePushMessage(JSONObject(json))

    companion object {
        fun from(json: JSONObject, receivedAt: Long): MessageEntity {
            val message = parsePushMessage(json)
            return MessageEntity(
                id = message.id,
                eventKey = message.eventKey,
                kind = message.kind,
                profileName = message.profileName,
                createdAt = message.createdAt,
                total = message.total,
                firstImage = message.items.firstNotNullOfOrNull { it.imageUrl },
                json = json.toString(),
                receivedAt = receivedAt,
            )
        }
    }
}

/** 点进煤炉（或其他来源）看过的商品。键是 PushItem.openKey。 */
@Entity(tableName = "item_opens")
data class ItemOpenEntity(
    @PrimaryKey val key: String,
    val openedAt: Long,
)

@Dao
interface MessageDao {
    /** 已有同一个 id 时返回 -1：说明这条弹过通知了，不再弹。 */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(message: MessageEntity): Long

    @Query("SELECT * FROM messages ORDER BY id DESC LIMIT 500")
    fun all(): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE id = :id")
    fun byId(id: Long): Flow<MessageEntity?>

    @Query("SELECT MAX(id) FROM messages")
    suspend fun maxId(): Long?

    @Query("DELETE FROM messages WHERE receivedAt < :before")
    suspend fun prune(before: Long)

    @Query("UPDATE messages SET openedAt = :at WHERE id = :id AND openedAt IS NULL")
    suspend fun markOpened(id: Long, at: Long)

    @Query("UPDATE messages SET openedAt = :at WHERE openedAt IS NULL")
    suspend fun markAllOpened(at: Long)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertOpen(open: ItemOpenEntity)

    @Query("SELECT `key` FROM item_opens")
    fun openedKeys(): Flow<List<String>>

    @Query("DELETE FROM item_opens WHERE openedAt < :before")
    suspend fun pruneOpens(before: Long)
}

@Database(entities = [MessageEntity::class, ItemOpenEntity::class], version = 2, exportSchema = false)
abstract class PushDatabase : RoomDatabase() {
    abstract fun messages(): MessageDao

    companion object {
        /**
         * 0.1 → 0.2：加已读 / 点开过。升级前收到的推送当作看过了（不然一装上就是二十几条未读）。
         */
        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE messages ADD COLUMN openedAt INTEGER")
                db.execSQL("UPDATE messages SET openedAt = receivedAt")
                db.execSQL("CREATE TABLE IF NOT EXISTS item_opens (`key` TEXT NOT NULL, openedAt INTEGER NOT NULL, PRIMARY KEY(`key`))")
            }
        }

        fun open(context: Context): PushDatabase =
            Room.databaseBuilder(context, PushDatabase::class.java, "push.db").addMigrations(MIGRATION_1_2).build()
    }
}
